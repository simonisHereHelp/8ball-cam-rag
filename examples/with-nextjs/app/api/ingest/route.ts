import { NextResponse } from "next/server";

export const runtime = "nodejs";

const INGEST_URL = "https://lenovo.ishere.help/ingest";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const response = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (json &&
          typeof json === "object" &&
          "error" in json &&
          typeof json.error === "string" &&
          json.error) ||
        `Ingest request failed with status ${response.status}.`;

      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json({ ingestOutput: json });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unable to reach ingest service.";
    console.error("Ingest Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
