import { NextResponse } from "next/server";

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
  source: string;
  documentId: string;
  title: string;
  issuer: string;
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
      source: { type: "string" },
      documentId: { type: "string" },
      title: { type: "string" },
      issuer: { type: "string" },
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
      "issuer",
      "abstractSummary",
      "normalizedText",
      "warnings",
      "stats",
    ],
  },
} as const;

const getPrompt = (extractOutput: ExtractOutput) => `
Transform the provided extract_output JSON into ingest_output JSON.

Requirements:
- Return JSON only.
- Preserve the exact output shape and field names.
- source must be "paddle-ocr".
- documentId should be a stable-looking generated identifier such as "doc-001" when no source id exists.
- title should use extract_output.title when present; otherwise infer a concise title from the document.
- issuer should identify the issuing organization if possible; otherwise return an empty string.
- abstractSummary should use extract_output.abstract when present; otherwise create a short summary.
- normalizedText should be the normalized plain text derived from the best available source, preferring plainText, then markdown/pages.
- warnings should contain short strings for uncertainty, missing issuer, or weak OCR signals; otherwise [].
- stats.sectionCount should estimate logical sections from headings/structure.
- stats.pageCount should equal pages.length when pages exists, otherwise 0.
- stats.characterCount should reflect normalizedText.length.
- Do not include extra keys.

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
              "You convert OCR extraction payloads into validated ingest JSON. Always return JSON that matches the requested schema exactly.",
          },
          {
            role: "user",
            content: getPrompt(extractOutput),
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

    return NextResponse.json({ ingestOutput });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to generate ingest output with OpenAI.";
    console.error("Ingest Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
