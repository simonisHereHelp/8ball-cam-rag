import { NextResponse } from "next/server";
import { GPT_Router } from "@/lib/gptRouter";
import {
  CANONICALS_BIBLE_SOURCE,
  SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE,
} from "@/lib/jsonCanonSources";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || "";
const OPENAI_INGEST_MODEL = process.env.OPENAI_INGEST_MODEL?.trim() || "gpt-4.1-mini";

interface ExtractPage {
  page?: number;
  markdown?: string;
  plainText?: string;
  contentList?: unknown[];
  imagePath?: string;
  processedImagePath?: string;
  ocrMetadata?: {
    preprocess?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
  };
  rawResult?: Record<string, unknown>;
}

interface ExtractOutput {
  markdown?: string;
  plainText?: string;
  title?: string;
  abstract?: string;
  pages?: ExtractPage[];
}

interface IngestOutput {
  documentDate: string;
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

const INGEST_OUTPUT_SCHEMA = {
  name: "ingest_output",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      documentDate: { type: "string" },
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
      "documentDate",
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

const getPrompt = (
  extractOutput: ExtractOutput,
  canonPromptBlock: string,
) => `
Transform the provided extract_output JSON into ingest_output JSON.

Requirements:
- Return JSON only.
- Preserve the exact output shape and field names.
- documentDate should contain the canonical document date when available, preferably as YYYYMMDD or a stable date-tag string such as "doc-20251127-001".
- title should use extract_output.title when present; otherwise infer a concise title from the document.
- issuer_name should identify the issuing organization if possible and be normalized to a canonical master when it matches a canonical master or alias; otherwise use the detected issuer name unchanged.
- subject_category: reason about the topic of this document and choose the single best matching canonized subject_category from the bible. Do not invent values outside the bible.
- doc_class: reason about the general document form, such as invoice, notice, statement, application form, and choose the best matching canonized doc_class allowed by the selected subject_category.
- action_in_verb: reason about the best action implied for the addressee and choose the best matching canonized action_in_verb allowed by the selected subject_category.
- abstractSummary should use extract_output.abstract when present; otherwise create a short summary.
- normalizedText should be the normalized plain text derived from the best available source, preferring plainText, then markdown/pages.
- normalizedText must begin with a markdown header in this format:
  # <title>

  ## Meta

  - issuer_name: <issuer_name>
  - subject_category: <subject_category>
  - doc_class: <doc_class>
  - action_in_verb: <action_in_verb>

- warnings should contain short strings for uncertainty, missing issuer, or weak OCR signals; otherwise [].
- stats.sectionCount should estimate logical sections from headings/structure.
- stats.pageCount should equal pages.length when pages exists, otherwise 0.
- stats.characterCount should reflect normalizedText.length.
- Do not include extra keys.

Canon data:
${canonPromptBlock}

extract_output JSON:
${JSON.stringify(extractOutput, null, 2)}
`.trim();

const validateExtractOutput = (value: unknown): ExtractOutput | null => {
  if (!value || typeof value !== "object") return null;

  const payload = value as ExtractOutput;
  return {
    markdown: typeof payload.markdown === "string" ? payload.markdown : "",
    plainText: typeof payload.plainText === "string" ? payload.plainText : "",
    title: typeof payload.title === "string" ? payload.title : "",
    abstract: typeof payload.abstract === "string" ? payload.abstract : "",
    pages: Array.isArray(payload.pages) ? payload.pages : [],
  };
};

const parseStructuredContent = (content: unknown): IngestOutput => {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI ingest response did not include JSON content.");
  }

  return JSON.parse(content) as IngestOutput;
};

export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    const extractOutput = validateExtractOutput(await req.json());

    if (!extractOutput) {
      return NextResponse.json({ error: "Invalid extract_output payload." }, { status: 400 });
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
    const canonPromptBlock = buildCanonPromptBlock({ issuers, taxonomy });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_INGEST_MODEL,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: INGEST_OUTPUT_SCHEMA,
        },
        messages: [
          {
            role: "system",
            content:
              "You convert OCR extraction payloads into validated ingest JSON. Always return JSON that matches the requested schema exactly. Choose the best match canonical subject_category, doc_class, and action_in_verb from the canon bible.",
          },
          {
            role: "user",
            content: getPrompt(extractOutput, canonPromptBlock),
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
        `OpenAI ingest request failed with status ${response.status}.`;

      return NextResponse.json({ error: message }, { status: response.status });
    }

    const message = data?.choices?.[0]?.message;

    if (typeof message?.refusal === "string" && message.refusal.trim()) {
      return NextResponse.json({ error: message.refusal }, { status: 422 });
    }

    const ingestOutput = parseStructuredContent(message?.content);
    ingestOutput.issuer_name = normalizeIssuerName(ingestOutput.issuer_name, issuers);

    return NextResponse.json({ ingestOutput });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to generate ingest output with OpenAI.";
    console.error("Ingest Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
