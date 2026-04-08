import { NextResponse } from "next/server";

import { extractAdvancedMarkdown } from "@/lib/extractAdvancedService";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const imageFiles = formData.getAll("image").filter((file): file is File => file instanceof File);

    if (!imageFiles.length) {
      return NextResponse.json({ error: "At least one image is required." }, { status: 400 });
    }

    const extracted = await extractAdvancedMarkdown(imageFiles);

    return NextResponse.json({
      summary: extracted.markdown,
      markdown: extracted.markdown,
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
