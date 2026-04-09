const DEFAULT_TIMEOUT_MS = 300_000;

export const getQwenIngestServiceBaseUrl = () =>
  process.env.QWEN_HF_URL?.trim().replace(/\/+$/g, "") || "";

export const getQwenIngestBearerToken = () =>
  process.env.QWEN_HF_TOKEN?.trim() || "";

export const getQwenIngestTimeoutMs = () =>
  Number(process.env.QWEN_HF_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

export const buildQwenIngestServiceUrl = (path: string) => {
  const baseUrl = getQwenIngestServiceBaseUrl();

  if (!baseUrl) {
    return "";
  }

  const normalizedPath = path.replace(/^\/+/g, "");
  return `${baseUrl}/${normalizedPath}`;
};
