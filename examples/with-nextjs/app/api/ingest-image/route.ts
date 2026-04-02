import { NextResponse } from "next/server";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || "";
const OPENAI_INGEST_IMAGE_MODEL =
  process.env.OPENAI_INGEST_IMAGE_MODEL?.trim() || "gpt-4.1-mini";

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

const fileToDataUrl = async (file: File) => {
  const buffer = Buffer.from(await file.arrayBuffer()).toString("base64");
  return `data:${file.type};base64,${buffer}`;
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

    const imageUrls = await Promise.all(imageFiles.map(fileToDataUrl));

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
              "You read one or more document images and produce validated ingest JSON. Extract the document text yourself and return JSON that matches the requested schema exactly.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Transform these document images into ingest_image_output JSON. Return JSON only. source must be 'paddle-ocr'. Generate title, issuer, abstractSummary, normalizedText, warnings, and stats from the images. normalizedText must contain the full normalized raw text reconstructed from the images as accurately as possible. stats.pageCount must equal the number of images.",
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

    return NextResponse.json({ ingestImageOutput });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to generate ingest-image output with OpenAI.";
    console.error("Ingest Image Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
