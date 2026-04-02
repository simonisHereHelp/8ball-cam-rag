import { NextResponse } from "next/server";
import { GPT_Router } from "@/lib/gptRouter";
import {
  CANONICALS_BIBLE_SOURCE,
  SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE,
} from "@/lib/jsonCanonSources";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || "";
const OPENAI_INGEST_IMAGE_MODEL =
  process.env.OPENAI_INGEST_IMAGE_MODEL?.trim() || "gpt-4.1-mini";

interface IngestOutput {
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

interface CanonicalIssuerEntry {
  master?: string;
  aliases?: string[];
}

interface TaxonomyEntry {
  topic?: string;
  description?: string;
  keywords?: string[];
  excluded_keywords?: string[];
  doc_classes?: string[];
  actionVerbs?: string[];
}

const INGEST_IMAGE_OUTPUT_SCHEMA = {
  name: "ingest_image_output",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string" },
      documentId: { type: "string" },
      title: { type: "string" },
      issuer_name: { type: "string" },
      subject_category: { type: "string" },
      doc_class: { type: "string" },
      action_in_verb: { type: "string" },
      abstractSummary: { type: "string" },
      normalizedText: { type: "string" },
      warnings: {
        type: "array",
        items: { type: "string" },
      },
      stats: {
        type: "object",
        additionalProperties: false,
        properties: {
          sectionCount: { type: "number" },
          pageCount: { type: "number" },
          characterCount: { type: "number" },
        },
        required: ["sectionCount", "pageCount", "characterCount"],
      },
    },
    required: [
      "source",
      "documentId",
      "title",
      "issuer_name",
      "subject_category",
      "doc_class",
      "action_in_verb",
      "abstractSummary",
      "normalizedText",
      "warnings",
      "stats",
    ],
  },
} as const;

const fileToDataUrl = async (file: File) => {
  const buffer = Buffer.from(await file.arrayBuffer()).toString("base64");
  return `data:${file.type};base64,${buffer}`;
};

const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const buildCanonPromptBlock = ({
  issuers,
  taxonomy,
}: {
  issuers: CanonicalIssuerEntry[];
  taxonomy: TaxonomyEntry[];
}) => {
  const issuerMapping = issuers.reduce<Record<string, string[]>>((acc, entry) => {
    const master = normalizeString(entry.master);
    if (!master) return acc;
    acc[master] = Array.isArray(entry.aliases)
      ? entry.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
      : [];
    return acc;
  }, {});

  const subjectRules = taxonomy.map((entry) => ({
    subject_category: normalizeString(entry.topic),
    description: normalizeString(entry.description),
    keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
    excluded_keywords: Array.isArray(entry.excluded_keywords) ? entry.excluded_keywords : [],
    doc_classes: Array.isArray(entry.doc_classes) ? entry.doc_classes : [],
    action_in_verbs: Array.isArray(entry.actionVerbs) ? entry.actionVerbs : [],
  }));

  return JSON.stringify(
    {
      issuerCanonicals: issuerMapping,
      subjectRules,
    },
    null,
    2,
  );
};

const normalizeIssuerName = (
  issuerName: string,
  issuers: CanonicalIssuerEntry[],
) => {
  const candidate = issuerName.trim().toLowerCase();
  if (!candidate) return issuerName;

  for (const entry of issuers) {
    const master = normalizeString(entry.master);
    if (!master) continue;

    if (master.toLowerCase() === candidate) {
      return master;
    }

    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    if (aliases.some((alias) => normalizeString(alias).toLowerCase() === candidate)) {
      return master;
    }
  }

  return issuerName;
};

const upsertMetaLine = (lines: string[], key: string, value: string) => {
  const matcher = new RegExp(`^-\\s*${key}\\s*:`, "i");
  const nextLine = `- ${key}: ${value}`;
  const index = lines.findIndex((line) => matcher.test(line.trim()));

  if (index >= 0) {
    lines[index] = nextLine;
  } else {
    lines.push(nextLine);
  }
};

const ensureNormalizedTextHeader = ({
  normalizedText,
  title,
  issuerName,
  subjectCategory,
  docClass,
  actionInVerb,
}: {
  normalizedText: string;
  title: string;
  issuerName: string;
  subjectCategory: string;
  docClass: string;
  actionInVerb: string;
}) => {
  const text = normalizedText.trim();
  const lines = text ? text.split(/\r?\n/) : [];

  let bodyLines = lines;
  if (bodyLines[0]?.trim().startsWith("# ")) {
    bodyLines = bodyLines.slice(1);
  }

  const metaIndex = bodyLines.findIndex((line) => /^##\s+meta\s*$/i.test(line.trim()));
  let beforeMeta: string[] = [];
  let metaLines: string[] = [];
  let afterMeta: string[] = [];

  if (metaIndex >= 0) {
    beforeMeta = bodyLines.slice(0, metaIndex);
    let cursor = metaIndex + 1;
    while (cursor < bodyLines.length && !/^##\s+/.test(bodyLines[cursor].trim())) {
      metaLines.push(bodyLines[cursor]);
      cursor += 1;
    }
    afterMeta = bodyLines.slice(cursor);
  } else {
    afterMeta = bodyLines.filter((line) => line.trim().length > 0);
  }

  const cleanedMetaLines = metaLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^-\s*title\s*:/i.test(line));

  upsertMetaLine(cleanedMetaLines, "issuer_name", issuerName);
  upsertMetaLine(cleanedMetaLines, "subject_category", subjectCategory);
  upsertMetaLine(cleanedMetaLines, "doc_class", docClass);
  upsertMetaLine(cleanedMetaLines, "action_in_verb", actionInVerb);

  const rebuilt = [
    `# ${title}`,
    "",
    "## Meta",
    "",
    ...cleanedMetaLines,
    "",
    ...beforeMeta.filter((line) => line.trim().length > 0),
    ...afterMeta,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return rebuilt;
};

const parseStructuredContent = (content: unknown): IngestOutput => {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI ingest-image response did not include JSON content.");
  }

  return JSON.parse(content) as IngestOutput;
};

export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    const formData = await req.formData();
    const imageFiles = formData.getAll("image").filter((file): file is File => file instanceof File);

    if (!imageFiles.length) {
      return NextResponse.json({ error: "At least one image is required." }, { status: 400 });
    }

    const [canonicalData, taxonomyData] = await Promise.all([
      GPT_Router._fetchFile(CANONICALS_BIBLE_SOURCE),
      GPT_Router._fetchFile(SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE),
    ]);

    const issuers = Array.isArray(canonicalData?.issuers)
      ? (canonicalData.issuers as CanonicalIssuerEntry[])
      : [];
    const taxonomy = Array.isArray(taxonomyData?.subfolders)
      ? (taxonomyData.subfolders as TaxonomyEntry[])
      : [];

    const imageUrls = await Promise.all(imageFiles.map(fileToDataUrl));
    const canonPromptBlock = buildCanonPromptBlock({ issuers, taxonomy });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_INGEST_IMAGE_MODEL,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: INGEST_IMAGE_OUTPUT_SCHEMA,
        },
        messages: [
          {
            role: "system",
            content:
              "You read one or more document images and produce validated ingest JSON. Extract the document text yourself and return JSON that matches the requested schema exactly. The normalizedText field must begin with a markdown-style meta header containing the title plus a Meta section with issuer_name, subject_category, doc_class, and action_in_verb.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `Transform these document images into ingest_image_output JSON.

Return JSON only.

Rules:
- source must be "paddle-ocr".
- Generate title, issuer_name, abstractSummary, normalizedText, warnings, and stats from the images.
- normalizedText must contain the full normalized raw text reconstructed from the images as accurately as possible.
- normalizedText must start with this markdown-style header:
  # <title>

  ## Meta

  - issuer_name: <normalized issuer name>
  - subject_category: <canonized subject category>
  - doc_class: <canonized doc class>
  - action_in_verb: <canonized action verb>

- issuer_name normalization rule: if the detected issuer matches an existing canonical master or alias, use the canonical master name; otherwise use the detected issuer name unchanged.
- subject_category: reason about what kind of topic this document is about and choose the single best matching canonized subject_category from the bible below.
- doc_class: reason about the general known form of this document, such as invoice, notice, statement, application form, and choose the single best matching canonized doc_class allowed by the selected subject_category.
- action_in_verb: reason about whether this document implies an action for the addressee and choose the single best matching canonized action_in_verb allowed by the selected subject_category.
- Do not invent non-bibled subject_category, doc_class, or action_in_verb values.
- stats.pageCount must equal the number of images.
- stats.characterCount must reflect normalizedText.length.

Canon data:
${canonPromptBlock}`,
              },
              ...imageUrls.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ],
          },
        ],
      }),
      cache: "no-store",
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (data &&
          typeof data === "object" &&
          "error" in data &&
          data.error &&
          typeof data.error === "object" &&
          "message" in data.error &&
          typeof data.error.message === "string" &&
          data.error.message) ||
        `OpenAI ingest-image request failed with status ${response.status}.`;

      return NextResponse.json({ error: message }, { status: response.status });
    }

    const message = data?.choices?.[0]?.message;

    if (typeof message?.refusal === "string" && message.refusal.trim()) {
      return NextResponse.json({ error: message.refusal }, { status: 422 });
    }

    const ingestImageOutput = parseStructuredContent(message?.content);
    const normalizedIssuer = normalizeIssuerName(ingestImageOutput.issuer_name, issuers);
    ingestImageOutput.issuer_name = normalizedIssuer;
    ingestImageOutput.normalizedText = ensureNormalizedTextHeader({
      normalizedText: ingestImageOutput.normalizedText,
      title: ingestImageOutput.title,
      issuerName: normalizedIssuer,
      subjectCategory: ingestImageOutput.subject_category,
      docClass: ingestImageOutput.doc_class,
      actionInVerb: ingestImageOutput.action_in_verb,
    });
    ingestImageOutput.stats.characterCount = ingestImageOutput.normalizedText.length;

    return NextResponse.json({ ingestImageOutput });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to generate ingest-image output with OpenAI.";
    console.error("Ingest Image Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
