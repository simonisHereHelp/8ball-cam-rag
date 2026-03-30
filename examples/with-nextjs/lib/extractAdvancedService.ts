const DEFAULT_TIMEOUT_MS = 120_000;

export interface AdvancedExtractResult {
  markdown: string;
  plainText?: string;
  title?: string;
  abstract?: string;
  pages?: Array<{
    page?: number;
    markdown?: string;
    plainText?: string;
  }>;
  raw?: unknown;
}

interface ExtractAdvancedOptions {
  systemPrompt?: string;
  userPrompt?: string;
}

const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const pickFirstString = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
};

const ensureMarkdown = (payload: any) => {
  const markdown = pickFirstString(
    payload?.markdown,
    payload?.md,
    payload?.result?.markdown,
    payload?.result?.md,
    payload?.data?.markdown,
    payload?.data?.md,
    payload?.content?.markdown,
  );

  if (markdown) return markdown;

  const plainText = pickFirstString(
    payload?.plainText,
    payload?.text,
    payload?.result?.plainText,
    payload?.result?.text,
    payload?.data?.plainText,
    payload?.data?.text,
  );

  if (plainText) return plainText;

  throw new Error("Advanced OCR service response did not include markdown/text content.");
};

export async function extractAdvancedMarkdown(
  files: File[],
  options: ExtractAdvancedOptions = {},
): Promise<AdvancedExtractResult> {
  const serviceUrl = process.env.MINERU_SERVICE_URL?.trim();

  if (!serviceUrl) {
    throw new Error("Missing MINERU_SERVICE_URL");
  }

  const timeoutMs = Number(process.env.MINERU_SERVICE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const formData = new FormData();

    files.forEach((file) => {
      formData.append("image", file, file.name);
      formData.append("files", file, file.name);
    });
    if (options.systemPrompt) {
      formData.append("systemPrompt", options.systemPrompt);
    }
    if (options.userPrompt) {
      formData.append("userPrompt", options.userPrompt);
    }

    const upstreamResponse = await fetch(serviceUrl, {
      method: "POST",
      headers: process.env.MINERU_SERVICE_BEARER_TOKEN
        ? {
            Authorization: `Bearer ${process.env.MINERU_SERVICE_BEARER_TOKEN}`,
          }
        : undefined,
      body: formData,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!upstreamResponse.ok) {
      const message = await upstreamResponse.text().catch(() => "");
      throw new Error(message || `Advanced OCR service failed (${upstreamResponse.status})`);
    }

    const contentType = upstreamResponse.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      const markdown = (await upstreamResponse.text()).trim();

      if (!markdown) {
        throw new Error("Advanced OCR service returned an empty body.");
      }

      return { markdown, raw: markdown };
    }

    const payload = await upstreamResponse.json();

    return {
      markdown: ensureMarkdown(payload),
      plainText: pickFirstString(
        payload?.plainText,
        payload?.text,
        payload?.result?.plainText,
        payload?.result?.text,
        payload?.data?.plainText,
        payload?.data?.text,
      ) || undefined,
      title: pickFirstString(
        payload?.title,
        payload?.meta?.title,
        payload?.data?.title,
      ) || undefined,
      abstract:
        pickFirstString(
          payload?.abstract,
          payload?.summary,
          payload?.meta?.abstract,
          payload?.data?.abstract,
        ) || undefined,
      pages: Array.isArray(payload?.pages) ? payload.pages : undefined,
      raw: payload,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Advanced OCR service timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
