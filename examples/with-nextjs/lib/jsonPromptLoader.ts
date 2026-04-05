import fs from "fs/promises";
import path from "path";

const resolveLocalPath = (source: string) => {
  const looksLikeDriveId = /^[a-zA-Z0-9_-]{10,}$/.test(source) && !source.includes("/");
  if (looksLikeDriveId || source.startsWith("http")) return null;

  return path.isAbsolute(source) ? source : path.join(process.cwd(), source);
};

export class JsonPromptLoader {
  static async fetchJsonSource(source: string): Promise<any> {
    if (!source) throw new Error("Source is required");

    const resolvedPath = resolveLocalPath(source);
    if (!resolvedPath) {
      throw new Error("Only local JSON sources are supported in this workspace.");
    }

    const fileContent = await fs.readFile(resolvedPath, "utf-8");
    return JSON.parse(fileContent);
  }

  static async getSystemPrompt(promptSource: string): Promise<string> {
    const config = await this.fetchJsonSource(promptSource);
    return config.system;
  }

  static async getUserPrompt(
    promptSource: string,
    options: {
      bibleData?: any;
      taxonomyData?: any;
      summary?: string;
      wordTarget?: number;
    },
  ): Promise<string> {
    const config = await this.fetchJsonSource(promptSource);
    let userPrompt = config.user;
    const { bibleData, taxonomyData, summary, wordTarget } = options;

    if (bibleData) {
      const issuerNames = bibleData.issuers?.map((i: any) => i.master) || [];
      const typeNames = bibleData.typeOfDoc?.map((t: any) => t.master) || [];
      const actionNames = bibleData.action?.map((a: any) => a.master) || [];
      const issuerMapping =
        bibleData.issuers?.reduce((acc: any, curr: any) => {
          acc[curr.master] = curr.aliases || [];
          return acc;
        }, {}) || {};

      userPrompt = userPrompt
        .replace("{{ISSUER_NAME}}", JSON.stringify(issuerNames))
        .replace("{{ISSUER_ALIASES}}", JSON.stringify(issuerMapping))
        .replace("{{TYPE_OF_DOC}}", JSON.stringify(typeNames))
        .replace("{{ACTION}}", JSON.stringify(actionNames));
    }

    if (taxonomyData) {
      const subfolders = Array.isArray(taxonomyData.subfolders) ? taxonomyData.subfolders : [];
      const subjectCategories = subfolders
        .map((entry: any) => entry?.topic)
        .filter((topic: unknown): topic is string => typeof topic === "string" && topic.trim().length > 0);

      const docClassOptions = Array.from(
        new Set(
          subfolders.flatMap((entry: any) =>
            Array.isArray(entry?.doc_classes) ? entry.doc_classes : [],
          ),
        ),
      );

      const actionVerbOptions = Array.from(
        new Set(
          subfolders.flatMap((entry: any) =>
            Array.isArray(entry?.actionVerbs) ? entry.actionVerbs : [],
          ),
        ),
      );

      const subjectRules = subfolders.map((entry: any) => ({
        subject_category: entry?.topic ?? "",
        description: entry?.description ?? "",
        keywords: Array.isArray(entry?.keywords) ? entry.keywords : [],
        excluded_keywords: Array.isArray(entry?.excluded_keywords) ? entry.excluded_keywords : [],
        doc_classes: Array.isArray(entry?.doc_classes) ? entry.doc_classes : [],
        action_in_verbs: Array.isArray(entry?.actionVerbs) ? entry.actionVerbs : [],
      }));

      userPrompt = userPrompt
        .replace("{{SUBJECT_CATEGORIES}}", JSON.stringify(subjectCategories))
        .replace("{{DOC_CLASS_OPTIONS}}", JSON.stringify(docClassOptions))
        .replace("{{ACTION_VERB_OPTIONS}}", JSON.stringify(actionVerbOptions))
        .replace("{{SUBJECT_RULES}}", JSON.stringify(subjectRules));
    }

    if (summary) {
      userPrompt = userPrompt.replace("{{SUMMARY}}", summary.trim());
    }

    const finalWordTarget = wordTarget || config.wordTarget || 250;
    return userPrompt.replace("{{wordTarget}}", String(finalWordTarget));
  }
}
