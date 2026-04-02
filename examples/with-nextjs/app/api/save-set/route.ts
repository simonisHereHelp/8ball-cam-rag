import { NextResponse } from "next/server";
import { Buffer } from "buffer";
import { driveSaveFiles } from "@/lib/driveSaveFiles";
import { GPT_Router } from "@/lib/gptRouter";
import {
  DRIVE_ACTIVE_SUBFOLDER_SOURCE,
  DRIVE_FALLBACK_FOLDER_ID,
} from "@/lib/jsonCanonSources";
import { normalizeFilename } from "@/lib/normalizeFilename";

interface IngestOutputPayload {
  source: string;
  documentId: string;
  title: string;
  issuer_name: string;
  subject_category: string;
  doc_class: string;
  action_in_verb: string;
  abstractSummary: string;
  normalizedText: string;
  warnings: string[];
  stats: {
    sectionCount: number;
    pageCount: number;
    characterCount: number;
  };
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

const deriveSetNameFromIngestOutput = (payload: IngestOutputPayload) => {
  const issuer = (payload.issuer_name || "document").trim();
  const docClass = (payload.doc_class || "Other").trim();
  const action = (payload.action_in_verb || "SafeKeep").trim();
  const datePart = deriveDatePart(
    payload.normalizedText || payload.abstractSummary || payload.title || "",
  );

  return normalizeFilename(
    `${issuer}-${docClass}-${action}-${datePart}`.replace(/[\\/:*?"<>|]/g, "-"),
  );
};

const parseIngestOutput = (value: string): IngestOutputPayload => {
  const payload = JSON.parse(value) as Partial<IngestOutputPayload>;

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.title !== "string" ||
    typeof payload.issuer_name !== "string" ||
    typeof payload.subject_category !== "string" ||
    typeof payload.doc_class !== "string" ||
    typeof payload.action_in_verb !== "string" ||
    typeof payload.normalizedText !== "string"
  ) {
    throw new Error("Invalid ingest-image-output.json payload.");
  }

  return {
    source: typeof payload.source === "string" ? payload.source : "paddle-ocr",
    documentId: typeof payload.documentId === "string" ? payload.documentId : "doc-001",
    title: payload.title,
    issuer_name: payload.issuer_name,
    subject_category: payload.subject_category,
    doc_class: payload.doc_class,
    action_in_verb: payload.action_in_verb,
    abstractSummary: typeof payload.abstractSummary === "string" ? payload.abstractSummary : "",
    normalizedText: payload.normalizedText,
    warnings: Array.isArray(payload.warnings)
      ? payload.warnings.filter((value): value is string => typeof value === "string")
      : [],
    stats: {
      sectionCount: Number(payload.stats?.sectionCount ?? 0),
      pageCount: Number(payload.stats?.pageCount ?? 0),
      characterCount: Number(payload.stats?.characterCount ?? payload.normalizedText.length),
    },
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
  const rawText = ingestOutput.normalizedText
    .replace(/\r/g, "")
    .replace(/^#\s+.*$/m, "")
    .replace(/^##\s+Meta\s*$/im, "")
    .replace(/^-+\s*issuer_name\s*:.*$/gim, "")
    .replace(/^-+\s*subject_category\s*:.*$/gim, "")
    .replace(/^-+\s*doc_class\s*:.*$/gim, "")
    .replace(/^-+\s*action_in_verb\s*:.*$/gim, "")
    .trim();

  return `# ${ingestOutput.title}

## Meta

- issuer_name: ${ingestOutput.issuer_name}
- subject_category: ${ingestOutput.subject_category}
- doc_class: ${ingestOutput.doc_class}
- action_in_verb: ${ingestOutput.action_in_verb}
- abstract_summary: ${ingestOutput.abstractSummary}

---

## Raw Text

${rawText}

## JSON Reference

[${setName}.json](./${setName}.json)

## Images

${imageSection}
`;
}

const resolveFolderBySubjectCategory = async (subjectCategory: string, baseFolderId: string) => {
  const config = await GPT_Router.fetchJsonSource(DRIVE_ACTIVE_SUBFOLDER_SOURCE).catch(() => null);
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
    const ingestImageOutputJson =
      (formData.get("ingestImageOutputJson") as string | null)?.trim() ?? "";
    const files = formData.getAll("files").filter((file): file is File => file instanceof File);

    if (!ingestImageOutputJson || !files.length) {
      return NextResponse.json({ error: "Ingest JSON and files are required." }, { status: 400 });
    }

    const ingestOutput = parseIngestOutput(ingestImageOutputJson);
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
