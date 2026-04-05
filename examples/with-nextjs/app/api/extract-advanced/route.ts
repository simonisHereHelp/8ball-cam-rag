import { NextResponse } from "next/server";

import { extractAdvancedMarkdown } from "@/lib/extractAdvancedService";
import { buildIngestedSummary } from "@/lib/ingestedSummary";
import { JsonPromptLoader } from "@/lib/jsonPromptLoader";
import {
  CANONICALS_BIBLE_SOURCE,
  PROMPT_EXTRACT_SOURCE,
  SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE,
} from "@/lib/jsonCanonSources";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const [bibleData, taxonomyData] = await Promise.all([
      JsonPromptLoader.fetchJsonSource(CANONICALS_BIBLE_SOURCE),
      JsonPromptLoader.fetchJsonSource(SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE),
    ]);
    const [systemPrompt, userPrompt] = await Promise.all([
      JsonPromptLoader.getSystemPrompt(PROMPT_EXTRACT_SOURCE),
      JsonPromptLoader.getUserPrompt(PROMPT_EXTRACT_SOURCE, { bibleData, taxonomyData }),
    ]);

    const formData = await req.formData();
    const imageFiles = formData.getAll("image").filter((file): file is File => file instanceof File);

    if (!imageFiles.length) {
      return NextResponse.json({ error: "At least one image is required." }, { status: 400 });
    }

    const extracted = await extractAdvancedMarkdown(imageFiles, {
      systemPrompt,
      userPrompt,
    });
    const ingestedSummary = buildIngestedSummary(extracted.markdown);

    return NextResponse.json({
      summary: extracted.markdown,
      markdown: extracted.markdown,
      ingestedSummary,
      plainText: extracted.plainText ?? "",
      title: extracted.title ?? "",
      abstract: extracted.abstract ?? "",
      pages: extracted.pages ?? [],
    });
  } catch (err: any) {
    console.error("Extract Advanced Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
