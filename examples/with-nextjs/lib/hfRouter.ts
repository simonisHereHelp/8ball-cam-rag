import fs from "fs/promises";
import path from "path";

export class HF_Router {
  static async _fetchFile(fileID: string): Promise<any> {
    if (!fileID) throw new Error("File ID is required");

    const resolvedPath = this._resolveLocalPath(fileID);
    if (!resolvedPath) {
      throw new Error("HF_Router only supports local JSON sources in this workspace.");
    }

    const fileContent = await fs.readFile(resolvedPath, "utf-8");
    return JSON.parse(fileContent);
  }

  static async fetchJsonSource(source: string): Promise<any> {
    return this._fetchFile(source);
  }

  static async getSystemPrompt(promptFileID: string): Promise<string> {
    const config = await this._fetchFile(promptFileID);
    return config.system;
  }

  static async getUserPrompt(
    promptFileID: string,
    options: {
      bibleData?: any;
      taxonomyData?: any;
      summary?: string;
      wordTarget?: number;
    },
  ): Promise<string> {
    const config = await this._fetchFile(promptFileID);
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
    userPrompt = userPrompt.replace("{{wordTarget}}", String(finalWordTarget));

    return userPrompt;
  }

  private static _resolveLocalPath(source: string) {
    const looksLikeDriveId = /^[a-zA-Z0-9_-]{10,}$/.test(source) && !source.includes("/");
    if (looksLikeDriveId || source.startsWith("http")) return null;

    return path.isAbsolute(source) ? source : path.join(process.cwd(), source);
  }
}
