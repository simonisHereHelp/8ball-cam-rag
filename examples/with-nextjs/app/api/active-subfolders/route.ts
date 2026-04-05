import { NextResponse } from "next/server";
import { DRIVE_ACTIVE_SUBFOLDER_SOURCE } from "@/lib/jsonCanonSources";
import { JsonPromptLoader } from "@/lib/jsonPromptLoader";

interface ActiveSubfolder {
  topic: string;
  folderId?: string;
  keywords?: string[];
  description?: string;
}

interface SubfolderConfig {
  subfolders?: ActiveSubfolder[];
}

const normalizeSubfolderConfig = (config: unknown): ActiveSubfolder[] => {
  if (!config) return [];
  if (Array.isArray(config)) return config as ActiveSubfolder[];
  const typed = config as SubfolderConfig;
  return Array.isArray(typed?.subfolders) ? typed.subfolders : [];
};

export async function GET() {
  try {
    const config = await JsonPromptLoader.fetchJsonSource(DRIVE_ACTIVE_SUBFOLDER_SOURCE);
    const subfolders = normalizeSubfolderConfig(config);
    return NextResponse.json({ subfolders }, { status: 200 });
  } catch (error) {
    console.warn("Failed to load active subfolders:", error);
    return NextResponse.json({ subfolders: [] }, { status: 200 });
  }
}
