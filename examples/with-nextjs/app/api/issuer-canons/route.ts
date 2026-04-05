import { NextResponse } from "next/server";
import { CANONICALS_BIBLE_SOURCE } from "@/lib/jsonCanonSources";
import { JsonPromptLoader } from "@/lib/jsonPromptLoader";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (!CANONICALS_BIBLE_SOURCE) {
      return NextResponse.json(
        { error: "Missing canonical source" },
        { status: 500 },
      );
    }

    const bibleData = await JsonPromptLoader.fetchJsonSource(CANONICALS_BIBLE_SOURCE);
    const issuers = bibleData?.issuers ?? [];

    return NextResponse.json({ issuers });
  } catch (err) {
    console.error("/api/issuer-canons failed:", err);
    return NextResponse.json(
      { error: "Unable to load issuer canons" },
      { status: 500 },
    );
  }
}
