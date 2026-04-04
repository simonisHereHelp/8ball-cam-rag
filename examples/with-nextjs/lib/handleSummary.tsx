// app/lib/handleSummary.ts

import { playSuccessChime } from "../app/components/image-capture-dialog-mobile/soundEffects";
import type { ExtractOutput } from "../app/components/image-capture-dialog-mobile/types";

export interface Image {
  url: string;
  file: File;
}

const extensionFromFile = (file: File) => {
  const nameExtension = file.name.split(".").pop()?.toLowerCase();
  if (nameExtension) return nameExtension;

  if (file.type === "image/png") return "png";
  if (file.type === "image/jpeg") return "jpg";

  return "jpg";
};

const buildSummaryTemplate = (images: Image[]) => {
  const assets =
    images.length > 0
      ? images
          .map((image, index) => {
            const page = index + 1;
            const extension = extensionFromFile(image.file);
            return `![page-${page}](./{{setName}}-p${page}.${extension})`;
          })
          .join("\n")
      : "![page-1](./{{setName}}-p1.jpg)";

  return `# Untitled Document

## Meta

- issuer_name:
- issuer_alias:
- date:
- doc_class:
- action_in_verb:
- subject_category:
- page_count: ${images.length}
- source_type: scanned_images
- extractor: PaddleOCR

## Summary

-

## Images

${assets}

---

## Content

`;
};

/**
 * Uploads all captured images to /api/extract-advanced and shows
 * the returned markdown body for user review/editing.
 */

export const handleSummary = async ({
  images,
  route = "/api/extract-advanced",
  setIsSaving,
  setSummary,
  setExtractOutput,
  setSummaryImageUrl,
  setShowSummaryOverlay,
  setError,
}: {
  images: Image[];
  route?: string;
  setIsSaving: (isSaving: boolean) => void;
  setSummary: (summary: string) => void;
  setExtractOutput: (output: ExtractOutput | null) => void;
  setSummaryImageUrl: (url: string | null) => void;
  setShowSummaryOverlay: (show: boolean) => void;
  setError: (message: string) => void;
}): Promise<boolean> => {
  if (images.length === 0) return false;

  const fallbackSummary = buildSummaryTemplate(images);

  setIsSaving(true);
  setError("");
  try {
    const formData = new FormData();

    images.forEach((image) => {
      formData.append("image", image.file);
    });

    images.forEach((image) => {
      if (image.url) {
        formData.append("imageUrl", image.url);
      }
    });

    const response = await fetch(route, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Failed to extract document.");
    }

    const data = (await response.json()) as Partial<ExtractOutput> & {
      summary?: string;
      markdown?: string;
    };
    const extractedMarkdown = data.markdown || data.summary || "";
    const resolvedSummary = extractedMarkdown.trim().length
      ? extractedMarkdown
      : fallbackSummary;

    setExtractOutput({
      markdown: data.markdown ?? extractedMarkdown,
      plainText: data.plainText ?? "",
      title: data.title ?? "",
      abstract: data.abstract ?? "",
      pages: data.pages ?? [],
    });
    setSummary(resolvedSummary);
    setSummaryImageUrl(images[images.length - 1].url);
    setShowSummaryOverlay(true);
    playSuccessChime();
    return true;
  } catch (error) {
    console.error("Failed to extract document:", error);
    setExtractOutput(null);
    setSummary(fallbackSummary);
    setSummaryImageUrl(null);
    setError("Unable to extract the captured document. Please edit the template markdown.");
    setShowSummaryOverlay(false);
    return true;
  } finally {
    setIsSaving(false);
  }
};
