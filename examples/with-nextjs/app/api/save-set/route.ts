import { NextResponse } from "next/server";
import { Buffer } from "buffer";
import { driveSaveFiles } from "@/lib/driveSaveFiles";
import {
  DRIVE_ACTIVE_SUBFOLDER_SOURCE,
  DRIVE_FALLBACK_FOLDER_ID,
} from "@/lib/jsonCanonSources";
import { JsonPromptLoader } from "@/lib/jsonPromptLoader";
import { normalizeFilename } from "@/lib/normalizeFilename";

interface IngestOutputPayload {
  "doc date": string;
  issuer_name: string;
  subject_category: string;
  doc_class: string;
  action_in_verb: string;
  abstractSummary: string;
}

interface ActiveSubfolder {
  topic: string;
  folderId?: string;
}

const buildFolderPath = (slugOrPath: string, base: string) => {
  if (!slugOrPath) return base;
  if (slugOrPath.startsWith(`${base}/`) || slugOrPath === base) return slugOrPath;
  if (slugOrPath.includes("/")) return slugOrPath;
  return `${base}/${slugOrPath}`;
};

const mimeTypeByExtension: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const resolveExtension = (fileName: string, fallback: string) => {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension && extension.length ? extension : fallback;
};

const resolveMimeType = (file: File, fallbackExtension: string) => {
  if (file.type) return file.type;
  const extension = resolveExtension(file.name, fallbackExtension);
  return mimeTypeByExtension[extension] ?? "application/octet-stream";
};

const compactFileNamePart = (value: string, fallback: string) => {
  const compacted = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/[\\/:*?"<>|]/g, "-");

  return compacted || fallback;
};

const normalizeDateToken = (year: number, month: number, day: number) =>
  `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;

const deriveDatePart = (text: string) => {
  const normalized = text.replace(/\r/g, " ");

  const isoMatch = normalized.match(/\b(20\d{2}|19\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
  if (isoMatch) {
    return normalizeDateToken(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const compactMatch = normalized.match(/\b(20\d{2}|19\d{2})(\d{2})(\d{2})\b/);
  if (compactMatch) {
    return normalizeDateToken(
      Number(compactMatch[1]),
      Number(compactMatch[2]),
      Number(compactMatch[3]),
    );
  }

  const rocMatch = normalized.match(/民國\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (rocMatch) {
    return normalizeDateToken(
      Number(rocMatch[1]) + 1911,
      Number(rocMatch[2]),
      Number(rocMatch[3]),
    );
  }

  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
};

const deriveDatePartFromPayload = (payload: IngestOutputPayload) => {
  const slashDateMatch = payload["doc date"].match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (slashDateMatch) {
    return `${slashDateMatch[3]}${slashDateMatch[2]}${slashDateMatch[1]}`;
  }

  const documentDateMatch = payload["doc date"].match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (documentDateMatch) {
    return `${documentDateMatch[1]}${documentDateMatch[2]}${documentDateMatch[3]}`;
  }

  const abstractDate = deriveDatePart(payload.abstractSummary || "");
  if (abstractDate !== new Date().toISOString().slice(0, 10).replace(/-/g, "")) {
    return abstractDate;
  }

  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
};

const deriveSetNameFromIngestOutput = (payload: IngestOutputPayload) => {
  const issuer = compactFileNamePart(payload.issuer_name || "document", "document");
  const docClass = compactFileNamePart(payload.doc_class || "Other", "Other");
  const action = compactFileNamePart(payload.action_in_verb || "SafeKeep", "SafeKeep");
  const datePart = deriveDatePartFromPayload(payload);

  return normalizeFilename(
    `${issuer}-${docClass}-${action}-${datePart}`,
  );
};

const parseIngestOutput = (value: string): IngestOutputPayload => {
  const payload = JSON.parse(value) as Partial<IngestOutputPayload>;

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload["doc date"] !== "string" ||
    typeof payload.issuer_name !== "string" ||
    typeof payload.subject_category !== "string" ||
    typeof payload.doc_class !== "string" ||
    typeof payload.action_in_verb !== "string"
  ) {
    throw new Error("Invalid ingest-image-output.json payload.");
  }

  return {
    "doc date": payload["doc date"],
    issuer_name: payload.issuer_name,
    subject_category: payload.subject_category,
    doc_class: payload.doc_class,
    action_in_verb: payload.action_in_verb,
    abstractSummary: typeof payload.abstractSummary === "string" ? payload.abstractSummary : "",
  };
};

function buildMarkdown(params: {
  setName: string;
  ingestOutput: IngestOutputPayload;
  imageFiles: File[];
}) {
  const { setName, ingestOutput, imageFiles } = params;
  const images = imageFiles.map((file, idx) => {
    const pageNumber = idx + 1;
    const extension = resolveExtension(file.name, "jpeg");
    return {
      alt: `page-${pageNumber}`,
      path: `./${setName}-p${pageNumber}.${extension}`,
    };
  });

  const imageSection = images.map((image) => `![${image.alt}](${image.path})`).join("\n");
  return `# ${ingestOutput.doc_class}

## Meta

- doc_date: ${ingestOutput["doc date"]}
- issuer_name: ${ingestOutput.issuer_name}
- subject_category: ${ingestOutput.subject_category}
- doc_class: ${ingestOutput.doc_class}
- action_in_verb: ${ingestOutput.action_in_verb}
- abstract_summary: ${ingestOutput.abstractSummary}

---

## Summary

${ingestOutput.abstractSummary}

## JSON Reference

[${setName}.json](./${setName}.json)

## Images

${imageSection}
`;
}

const resolveFolderBySubjectCategory = async (subjectCategory: string, baseFolderId: string) => {
  const config = await JsonPromptLoader.fetchJsonSource(DRIVE_ACTIVE_SUBFOLDER_SOURCE).catch(() => null);
  const subfolders = Array.isArray((config as { subfolders?: ActiveSubfolder[] } | null)?.subfolders)
    ? ((config as { subfolders?: ActiveSubfolder[] }).subfolders ?? [])
    : Array.isArray(config)
      ? (config as ActiveSubfolder[])
      : [];

  const matched = subfolders.find(
    (entry) => entry.topic?.toLowerCase() === subjectCategory.toLowerCase(),
  );

  if (!matched) {
    return {
      folderId: buildFolderPath(DRIVE_FALLBACK_FOLDER_ID || baseFolderId, baseFolderId),
      topic: null,
    };
  }

  return {
    folderId: buildFolderPath(matched.folderId || matched.topic, baseFolderId),
    topic: matched.topic,
  };
};

export const runtime = "nodejs";

const BASE_DRIVE_FOLDER_ID = DRIVE_FALLBACK_FOLDER_ID;
const ROOT_DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

export async function POST(request: Request) {
  if (!ROOT_DRIVE_FOLDER_ID && !BASE_DRIVE_FOLDER_ID) {
    return NextResponse.json({ error: "Missing DRIVE_FOLDER_ID" }, { status: 500 });
  }

  try {
    const formData = await request.formData();
    const ingestOutputJson = (formData.get("ingestOutputJson") as string | null)?.trim() ?? "";
    const files = formData.getAll("files").filter((file): file is File => file instanceof File);

    if (!ingestOutputJson || !files.length) {
      return NextResponse.json({ error: "Ingest JSON and files are required." }, { status: 400 });
    }

    const ingestOutput = parseIngestOutput(ingestOutputJson);
    const normalizedSetName = deriveSetNameFromIngestOutput(ingestOutput);

    const baseFolderId = ROOT_DRIVE_FOLDER_ID || BASE_DRIVE_FOLDER_ID;
    if (!baseFolderId) {
      return NextResponse.json({ error: "Missing DRIVE_FOLDER_ID" }, { status: 500 });
    }

    const resolved = await resolveFolderBySubjectCategory(
      ingestOutput.subject_category,
      baseFolderId,
    );
    const targetFolderId = resolved.folderId;
    const topic = resolved.topic;

    const imageFiles = files;
    const markdown = buildMarkdown({
      setName: normalizedSetName,
      ingestOutput,
      imageFiles,
    });

    const jsonFile = new File([JSON.stringify(ingestOutput, null, 2)], "ingest-image-output.json", {
      type: "application/json",
    });
    const markdownFile = new File([markdown], "ingest-image-output.md", {
      type: "text/markdown",
    });
    const uploadFiles = [...imageFiles, jsonFile, markdownFile];

    await driveSaveFiles({
      folderId: targetFolderId,
      files: uploadFiles,
      fileToUpload: async (file) => {
        const baseName = normalizeFilename(normalizedSetName.replace(/[\\/:*?"<>|]/g, "_"));
        const extension = resolveExtension(file.name, "dat");

        const fileName = normalizeFilename(
          file === markdownFile || file.name === "ingest-image-output.md"
            ? `${baseName}.md`
            : file === jsonFile || file.name === "ingest-image-output.json"
              ? `${baseName}.json`
              : `${baseName}-p${imageFiles.indexOf(file) + 1}.${extension}`,
        );

        return {
          name: fileName,
          buffer: Buffer.from(await file.arrayBuffer()),
          mimeType: resolveMimeType(file, extension),
        };
      },
    });

    return NextResponse.json(
      { setName: normalizedSetName, targetFolderId, topic },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unable to save files.";
    console.error("save-set failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
