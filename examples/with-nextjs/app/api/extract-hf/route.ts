import { NextResponse } from "next/server";
import { HF_Router } from "@/lib/hfRouter";
import {
  CANONICALS_BIBLE_SOURCE,
  PROMPT_EXTRACT_SOURCE,
  SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE,
} from "@/lib/jsonCanonSources";

export const runtime = "nodejs";

const HF_TOKEN = process.env.HF_TOKEN?.trim() || "";
const HF_BASE_URL = process.env.HF_URL?.trim() || "";
const HF_EXTRACT_URL = `${HF_BASE_URL.replace(/\/+$/g, "")}/extract`;

export async function POST(req: Request) {
  try {
    if (!HF_BASE_URL) {
      throw new Error("Missing HF_URL");
    }

    const [bibleData, taxonomyData] = await Promise.all([
      HF_Router._fetchFile(CANONICALS_BIBLE_SOURCE),
      HF_Router._fetchFile(SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE),
    ]);
    const [systemPrompt, userPrompt] = await Promise.all([
      HF_Router.getSystemPrompt(PROMPT_EXTRACT_SOURCE),
      HF_Router.getUserPrompt(PROMPT_EXTRACT_SOURCE, { bibleData, taxonomyData }),
    ]);

    const formData = await req.formData();
    const imageFiles = formData.getAll("image").filter((file): file is File => file instanceof File);

    if (!imageFiles.length) {
      return NextResponse.json({ error: "At least one image is required." }, { status: 400 });
    }

    const upstreamFormData = new FormData();
    imageFiles.forEach((file) => {
      upstreamFormData.append("image", file, file.name);
    });
    upstreamFormData.append("systemPrompt", systemPrompt);
    upstreamFormData.append("userPrompt", userPrompt);

    const response = await fetch(HF_EXTRACT_URL, {
      method: "POST",
      headers: HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : undefined,
      body: upstreamFormData,
      cache: "no-store",
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string" &&
          payload.error) ||
        `HF extract failed (${response.status})`;
      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json({
      summary: payload?.markdown ?? payload?.summary ?? "",
      markdown: payload?.markdown ?? payload?.summary ?? "",
      plainText: payload?.plainText ?? "",
      title: payload?.title ?? "",
      abstract: payload?.abstract ?? "",
      pages: Array.isArray(payload?.pages) ? payload.pages : [],
    });
  } catch (err: any) {
    console.error("Extract HF Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
