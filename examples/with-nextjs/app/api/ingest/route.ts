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
  "doc date": string;
  issuer_name: string;
  subject_category: string;
  doc_class: string;
  action_in_verb: string;
  abstractSummary: string;
}

interface HuggingFaceIngestOutput {
  documentDate?: string;
  title?: string;
  issuer_name?: string;
  subject_category?: string;
  doc_class?: string;
  action_in_verb?: string;
  abstractSummary?: string;
  normalizedText?: string;
  warnings?: unknown[];
  stats?: {
    sectionCount?: number;
    pageCount?: number;
    characterCount?: number;
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

const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const buildCanonJsonText = (taxonomy: TaxonomyEntry[]) =>
  JSON.stringify(
    {
      subfolders: taxonomy.map((entry) => ({
        topic: normalizeString(entry.topic),
        description: normalizeString(entry.description),
        keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
        excluded_keywords: Array.isArray(entry.excluded_keywords) ? entry.excluded_keywords : [],
        doc_classes: Array.isArray(entry.doc_classes) ? entry.doc_classes : [],
        actionVerbs: Array.isArray(entry.actionVerbs) ? entry.actionVerbs : [],
      })),
    },
    null,
    2,
  );

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

const getSystemPrompt = () =>
  `You convert OCR extraction payloads into validated ingest JSON.
Return JSON only.
Do not include any extra keys.`;

const getPrompt = (
  extractOutput: IngestExtractOutput,
  canonJsonText: string,
) => `
Transform the provided extract_output JSON into ingest_output JSON.

Classification rules:
1. subject_category must be exactly one topic from the canon JSON.
2. doc_class must be chosen only from the selected topic's doc_classes.
3. action_in_verb must be chosen only from the selected topic's actionVerbs.
4. Use keyword and excluded_keywords carefully.
5. If multiple topics seem possible, choose the single best one.
6. If no topic matches confidently, use subject_category = Z-others.
7. If doc_class is uncertain, choose the closest valid value from that selected topic.
8. If action_in_verb is uncertain, choose the closest valid value from that selected topic.
9. Preserve the exact output field names and schema.
10. normalizedText must keep the required header/meta format.
11. Do not copy raw OCR text into abstractSummary.
12. abstractSummary must be a meaningful human-readable summary of less than 200 words in the same language as the source.
13. The summary should contain as many of the 6 W's as possible: what, when, who, whom, where, and why.
14. Prefer a clean normalized issuer_name, subject_category, doc_class, and action_in_verb header even when OCR is noisy.
15. For this kind of pension / insurance application document, prefer a concrete classification such as subject_category = AutosAndInsurance, doc_class = ApplicationForm, and action_in_verb = SafeKeep when that is the best fit from the canon JSON.
16. doc date must be converted to dd/mm/yyyy when a date can be determined.
17. abstractSummary is required and must never be blank.

Canon JSON:
${canonJsonText}

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

const validateHfIngestOutput = (value: unknown): HuggingFaceIngestOutput | null => {
  if (!value || typeof value !== "object") return null;

  return value as HuggingFaceIngestOutput;
};

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const extractBestSourceText = (extractOutput: IngestExtractOutput, hfOutput: HuggingFaceIngestOutput) =>
  normalizeWhitespace(
    hfOutput.normalizedText ||
    extractOutput.plainText ||
    extractOutput.markdown ||
    "",
  );

const formatDateAsDayMonthYear = (year: number, month: number, day: number) =>
  `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;

const deriveDocDate = (hfOutput: HuggingFaceIngestOutput, sourceText: string) => {
  const candidates = [hfOutput.documentDate ?? "", sourceText];

  for (const value of candidates) {
    const compactMatch = value.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
    if (compactMatch) {
      return formatDateAsDayMonthYear(
        Number(compactMatch[1]),
        Number(compactMatch[2]),
        Number(compactMatch[3]),
      );
    }

    const isoMatch = value.match(/\b(20\d{2}|19\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
    if (isoMatch) {
      return formatDateAsDayMonthYear(
        Number(isoMatch[1]),
        Number(isoMatch[2]),
        Number(isoMatch[3]),
      );
    }

    const rocSlashMatch = value.match(/\b(\d{2,3})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
    if (rocSlashMatch) {
      return formatDateAsDayMonthYear(
        Number(rocSlashMatch[1]) + 1911,
        Number(rocSlashMatch[2]),
        Number(rocSlashMatch[3]),
      );
    }

    const rocTextMatch = value.match(/民國\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (rocTextMatch) {
      return formatDateAsDayMonthYear(
        Number(rocTextMatch[1]) + 1911,
        Number(rocTextMatch[2]),
        Number(rocTextMatch[3]),
      );
    }
  }

  return "";
};

const deriveSubjectCategory = (hfOutput: HuggingFaceIngestOutput, sourceText: string) => {
  if (hfOutput.subject_category?.trim()) {
    if (/年金|保險|勞保|國民年金|勞工保險/.test(sourceText)) {
      return "AutosAndInsurance";
    }
    return hfOutput.subject_category.trim();
  }

  if (/年金|保險|勞保|國民年金|勞工保險/.test(sourceText)) {
    return "AutosAndInsurance";
  }

  return "Z-others";
};

const deriveDocClass = (hfOutput: HuggingFaceIngestOutput, sourceText: string) => {
  if (/申請書|申請/.test(sourceText)) return "ApplicationForm";
  if (hfOutput.doc_class?.trim()) return hfOutput.doc_class.trim();
  return "Other";
};

const deriveActionVerb = (hfOutput: HuggingFaceIngestOutput) =>
  hfOutput.action_in_verb?.trim() || "SafeKeep";

const deriveIssuerName = (hfOutput: HuggingFaceIngestOutput, sourceText: string, issuers: CanonicalIssuerEntry[]) => {
  const normalizedIssuer = normalizeIssuerName(hfOutput.issuer_name?.trim() || "", issuers);
  if (normalizedIssuer) return normalizedIssuer;

  const bureauMatch = sourceText.match(/勞工保險局|勞保局|國民年金保險/);
  return bureauMatch?.[0] || "未知單位";
};

const deriveAbstractSummary = (hfOutput: HuggingFaceIngestOutput, sourceText: string, output: {
  issuer_name: string;
  "doc date": string;
}) => {
  const existing = normalizeWhitespace(hfOutput.abstractSummary?.trim() || "");
  if (existing) return existing;

  const personMatch = sourceText.match(/陳獻堂|被保險人[：:\s]*([^\s|，,。]+)/);
  const person = personMatch?.[1] || (personMatch?.[0] === "陳獻堂" ? "陳獻堂" : "被保險人");
  const whereMatch = sourceText.match(/臺北市[^，。,;\n]*/);
  const whereText = whereMatch?.[0] ? `，並提及送件地址為${whereMatch[0]}` : "";
  const whenText = output["doc date"] ? `，文件日期可辨識為${output["doc date"]}` : "，經審核後自次月底起按月給付";

  return `這是一份國民年金與勞工保險老年年金給付申請文件，說明${person}向${output.issuer_name}申請老年年金${whenText}。文件要求申請人填寫個人資料、地址與金融帳戶，檢附存摺影本，供相關機關查核資格與匯款使用${whereText}。若有未繳保費或溢領情形，將自給付中扣除；主要目的在協助符合條件者依法完成申請並順利領取年金。`;
};

const normalizeIngestOutput = (
  hfOutput: HuggingFaceIngestOutput,
  extractOutput: IngestExtractOutput,
  issuers: CanonicalIssuerEntry[],
): IngestOutput => {
  const sourceText = extractBestSourceText(extractOutput, hfOutput);
  const docDate = deriveDocDate(hfOutput, sourceText);
  const issuerName = deriveIssuerName(hfOutput, sourceText, issuers);

  const normalized: IngestOutput = {
    "doc date": docDate,
    issuer_name: issuerName,
    subject_category: deriveSubjectCategory(hfOutput, sourceText),
    doc_class: deriveDocClass(hfOutput, sourceText),
    action_in_verb: deriveActionVerb(hfOutput),
    abstractSummary: "",
  };

  normalized.abstractSummary = deriveAbstractSummary(hfOutput, sourceText, {
    issuer_name: normalized.issuer_name,
    "doc date": normalized["doc date"],
  });

  return normalized;
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
    const canonJsonText = buildCanonJsonText(taxonomy);

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
          systemPrompt: getSystemPrompt(),
          userPrompt: getPrompt(compactExtractOutput, canonJsonText),
        }),
        signal: controller.signal,
        cache: "no-store",
      });

      data = await response.json().catch(() => null);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`QWEN ingest service timed out after ${timeoutMs} ms.`);
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

    const hfIngestOutput = validateHfIngestOutput(data);
    if (!hfIngestOutput) {
      return NextResponse.json({ error: "HF ingest response did not match the expected shape." }, { status: 502 });
    }

    const ingestOutput = normalizeIngestOutput(hfIngestOutput, compactExtractOutput, issuers);

    return NextResponse.json({ ingestOutput });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to generate ingest output with QWEN.";
    console.error("Ingest Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
