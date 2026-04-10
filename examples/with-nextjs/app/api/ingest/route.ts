import { NextResponse } from "next/server";
import { JsonPromptLoader } from "@/lib/jsonPromptLoader";
import {
  buildQwenIngestServiceUrl,
  getQwenIngestBearerToken,
  getQwenIngestTimeoutMs,
} from "@/lib/qwenIngestService";
import {
  CANONICALS_BIBLE_SOURCE,
  SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE,
} from "@/lib/jsonCanonSources";

export const runtime = "nodejs";

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

interface IngestExtractPage {
  page: number;
}

interface IngestExtractOutput {
  markdown: string;
  plainText: string;
  title: string;
  abstract: string;
  pages: IngestExtractPage[];
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

interface CanonicalIssuerEntry {
  master?: string;
  aliases?: string[];
}

interface CanonicalsBible {
  issuers?: CanonicalIssuerEntry[];
  typeOfDoc?: unknown[];
  action?: unknown[];
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
  canonicals,
  taxonomy,
}: {
  canonicals: CanonicalsBible;
  taxonomy: TaxonomyEntry[];
}) => {
  return JSON.stringify(
    {
      canonJson: {
        subfolders: taxonomy.map((entry) => ({
          topic: normalizeString(entry.topic),
          description: normalizeString(entry.description),
          keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
          excluded_keywords: Array.isArray(entry.excluded_keywords) ? entry.excluded_keywords : [],
          doc_classes: Array.isArray(entry.doc_classes) ? entry.doc_classes : [],
          actionVerbs: Array.isArray(entry.actionVerbs) ? entry.actionVerbs : [],
        })),
      },
      canonicalIssuers: {
        issuers: Array.isArray(canonicals.issuers)
          ? canonicals.issuers.map((entry) => ({
              master: normalizeString(entry.master),
              aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
            }))
          : [],
      },
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
  extractOutput: IngestExtractOutput,
  canonPromptBlock: string,
) => `
Transform the provided extract_output JSON into ingest_output JSON.

Classification rules:
1. Return JSON only.
2. Do not include any extra keys.
3. Preserve the exact output shape and field names.
4. documentDate should contain the canonical document date when available, preferably as YYYYMMDD.
5. title should use extract_output.title when present; otherwise infer a concise title from the document.
6. issuer_name should identify the issuing organization if possible and be normalized to a canonical master when it matches a canonical master or alias; otherwise use the detected issuer name unchanged.
7. subject_category must be exactly one topic from the canon JSON.
8. doc_class must be chosen only from the selected topic's doc_classes.
9. action_in_verb must be chosen only from the selected topic's actionVerbs.
10. Use keyword and excluded_keywords carefully.
11. If multiple topics seem possible, choose the single best one.
12. If no topic matches confidently, use subject_category = Z-others.
13. If doc_class is uncertain, choose the closest valid value from that selected topic.
14. If action_in_verb is uncertain, choose the closest valid value from that selected topic.
15. abstractSummary should use extract_output.abstract when present; otherwise create a short summary.
16. normalizedText should be the normalized plain text derived from the best available source, preferring plainText, then markdown/pages.
17. normalizedText must begin with a markdown header in this format:
  # <title>

  ## Meta

  - issuer_name: <issuer_name>
  - subject_category: <subject_category>
  - doc_class: <doc_class>
  - action_in_verb: <action_in_verb>
18. warnings should contain short strings for uncertainty, missing issuer, or weak OCR signals; otherwise [].
19. stats.sectionCount should estimate logical sections from headings/structure.
20. stats.pageCount should equal pages.length when pages exists, otherwise 0.
21. stats.characterCount should reflect normalizedText.length.
22. Always populate subject_category, doc_class, action_in_verb, and abstractSummary. Never leave them empty. Use Z-others and the closest valid doc_class/action_in_verb when OCR is weak.

Canon JSON:
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

const compactExtractOutputForIngest = (extractOutput: ExtractOutput): IngestExtractOutput => ({
  markdown: typeof extractOutput.markdown === "string" ? extractOutput.markdown : "",
  plainText: typeof extractOutput.plainText === "string" ? extractOutput.plainText : "",
  title: typeof extractOutput.title === "string" ? extractOutput.title : "",
  abstract: typeof extractOutput.abstract === "string" ? extractOutput.abstract : "",
  // Keep only page numbering for stats/page count. The actual text lives in the top-level fields.
  pages: Array.isArray(extractOutput.pages)
    ? extractOutput.pages.map((page, index) => ({
        page: typeof page?.page === "number" ? page.page : index + 1,
      }))
    : [],
});

const validateIngestOutput = (value: unknown): IngestOutput | null => {
  if (!value || typeof value !== "object") return null;

  const payload = value as Partial<IngestOutput>;

  if (
    typeof payload.documentDate !== "string" ||
    typeof payload.title !== "string" ||
    typeof payload.issuer_name !== "string" ||
    typeof payload.subject_category !== "string" ||
    typeof payload.doc_class !== "string" ||
    typeof payload.action_in_verb !== "string" ||
    typeof payload.abstractSummary !== "string" ||
    typeof payload.normalizedText !== "string" ||
    !Array.isArray(payload.warnings) ||
    !payload.stats ||
    typeof payload.stats.sectionCount !== "number" ||
    typeof payload.stats.pageCount !== "number" ||
    typeof payload.stats.characterCount !== "number"
  ) {
    return null;
  }

  return {
    documentDate: payload.documentDate,
    title: payload.title,
    issuer_name: payload.issuer_name,
    subject_category: payload.subject_category,
    doc_class: payload.doc_class,
    action_in_verb: payload.action_in_verb,
    abstractSummary: payload.abstractSummary,
    normalizedText: payload.normalizedText,
    warnings: payload.warnings.filter((item): item is string => typeof item === "string"),
    stats: payload.stats,
  };
};

export async function POST(req: Request) {
  try {
    const ingestServiceUrl = buildQwenIngestServiceUrl("/ingest");

    if (!ingestServiceUrl) {
      throw new Error("Missing QWEN_HF_URL");
    }

    const extractOutput = validateExtractOutput(await req.json());

    if (!extractOutput) {
      return NextResponse.json({ error: "Invalid extract_output payload." }, { status: 400 });
    }

    const compactExtractOutput = compactExtractOutputForIngest(extractOutput);

    const [canonicalData, taxonomyData] = await Promise.all([
      JsonPromptLoader.fetchJsonSource(CANONICALS_BIBLE_SOURCE),
      JsonPromptLoader.fetchJsonSource(SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE),
    ]);

    const issuers = Array.isArray(canonicalData?.issuers)
      ? (canonicalData.issuers as CanonicalIssuerEntry[])
      : [];
    const taxonomy = Array.isArray(taxonomyData?.subfolders)
      ? (taxonomyData.subfolders as TaxonomyEntry[])
      : [];
    const canonPromptBlock = buildCanonPromptBlock({
      canonicals: (canonicalData ?? {}) as CanonicalsBible,
      taxonomy,
    });

    const bearerToken = getQwenIngestBearerToken();
    const timeoutMs = getQwenIngestTimeoutMs();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    let data: unknown = null;

    try {
      response = await fetch(ingestServiceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({
          ...compactExtractOutput,
          systemPrompt: [
            "You convert OCR extraction payloads into validated ingest JSON.",
            "Return JSON only.",
            "Do not include any extra keys.",
          ].join(" "),
          userPrompt: getPrompt(compactExtractOutput, canonPromptBlock),
        }),
        signal: controller.signal,
        cache: "no-store",
      });

      data = await response.json().catch(() => null);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("QWEN ingest service timed out.");
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const message =
        (data &&
          typeof data === "object" &&
          "error" in data &&
          typeof data.error === "string" &&
          data.error) ||
        `QWEN ingest request failed with status ${response.status}.`;

      return NextResponse.json({ error: message }, { status: response.status });
    }

    const ingestOutput = validateIngestOutput(data);
    if (!ingestOutput) {
      return NextResponse.json({ error: "HF ingest response did not match the expected shape." }, { status: 502 });
    }

    ingestOutput.issuer_name = normalizeIssuerName(ingestOutput.issuer_name, issuers);

    return NextResponse.json({ ingestOutput });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to generate ingest output with QWEN.";
    console.error("Ingest Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
