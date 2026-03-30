// @/lib/gptRouter.ts
import fs from "fs/promises";
import path from "path";
import { auth } from "@/auth";

export class GPT_Router {
  /**
   * 通用 Fetch 工具：根據 ID 獲取檔案並解析為 JSON
   */
  static async _fetchFile(fileID: string, useAuth: boolean = false): Promise<any> {
    if (!fileID) throw new Error("File ID is required");

    const resolvedPath = this._resolveLocalPath(fileID);

    if (resolvedPath) {
      const fileContent = await fs.readFile(resolvedPath, "utf-8");
      return JSON.parse(fileContent);
    }

    let url = `https://drive.google.com/uc?export=download&id=${fileID}`;
    const headers: HeadersInit = {};

    if (useAuth) {
      const session = await auth();
      const accessToken = (session as any)?.accessToken;
      if (!accessToken) throw new Error("Missing Google Drive access token");

      // 使用 API 格式讀取私有媒體內容
      url = `https://www.googleapis.com/drive/v3/files/${fileID}?alt=media&supportsAllDrives=true`;
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Fetch file ${fileID} failed (Status: ${res.status})`);

    return res.json();
  }

  /**
   * Fetch arbitrary JSON sources using the same ID/path resolution.
   */
  static async fetchJsonSource(source: string, useAuth: boolean = false): Promise<any> {
    return this._fetchFile(source, useAuth);
  }

  /**
   * 獲取 System Prompt
   */
  static async getSystemPrompt(promptFileID: string): Promise<string> {
    const config = await this._fetchFile(promptFileID);
    return config.system;
  }

  /**
   * 通用的 User Prompt 產生器
   * @param promptFileID - 模板 ID (summary 或 setName)
   * @param options - 包含 bibleData 或 summary 的物件
   */
  static async getUserPrompt(
    promptFileID: string,
    options: {
      bibleData?: any;
      taxonomyData?: any;
      summary?: string;
      wordTarget?: number;
    }
  ): Promise<string> {
    const config = await this._fetchFile(promptFileID);
    let userPrompt = config.user;
    const { bibleData, taxonomyData, summary, wordTarget } = options;

    // 1. 處理 Bible 數據替換 (用於 Summarize 階段)
    if (bibleData) {
      // 1. 提取標準名稱列表 (用於輸出的唯一選項)
      const issuerNames = bibleData.issuers?.map((i: any) => i.master) || [];
      const typeNames = bibleData.typeOfDoc?.map((t: any) => t.master) || [];
      const actionNames = bibleData.action?.map((a: any) => a.master) || [];

      // 2. 提取「標準名與別名」的對照參考 (用於加強 GPT 的比對能力)
      // 格式如:{"兆豐": ["兆豐銀行", "Mega Bank"], "勞保局": ["勞工保險局"]}
      const issuerMapping =
        bibleData.issuers?.reduce((acc: any, curr: any) => {
          acc[curr.master] = curr.aliases || [];
          return acc;
        }, {}) || {};

      // 3. 執行替換
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

    // 處理摘要替換 (用於 SetName 階段)
    if (summary) {
      userPrompt = userPrompt.replace("{{SUMMARY}}", summary.trim());
    }

    // 3. 處理字數限制 (優先序: 呼叫參數 > JSON 配置 > 硬編碼預設)
    const finalWordTarget = wordTarget || config.wordTarget || 250;
    userPrompt = userPrompt.replace("{{wordTarget}}", String(finalWordTarget));

    return userPrompt;
  }

  /**
   * Use GPT to extract the "Issuer Name" (the canonical master name) from a summary.
   */
  static async getIssuerName(summary: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "你是一位精確的實體提取助手。請從提供的摘要中僅提取『寄件單位』或『機構名稱』。只需回傳名稱，不要有標點符號或解釋。如果找不到，請回傳『其他單位』。",
          },
          { role: "user", content: summary },
        ],
        temperature: 0,
      }),
    });

    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || "其他單位";
  }

  static async updateCanonicals(
    fileID: string,
    {
      issuerName,
      issuerAlias,
    }: {
      issuerName: string;
      issuerAlias: string;
    }
  ) {
    const localPath = this._resolveLocalPath(fileID);
    if (localPath) {
      throw new Error(
        "Updating local canonical files is not supported. Provide a Drive file ID via environment variable."
      );
    }

    const bibleData = await this._fetchFile(fileID, true);

    const masterEntry = bibleData.issuers.find((i: any) => i.master === issuerName);

    if (masterEntry) {
      // Master exists, check if alias is new
      if (issuerAlias !== issuerName && !masterEntry.aliases.includes(issuerAlias)) {
        masterEntry.aliases.push(issuerAlias);
      } else {
        return { status: "NO_CHANGE", message: "Alias already exists or matches master." };
      }
    } else {
      // New Master
      bibleData.issuers.push({
        master: issuerName,
        aliases: issuerAlias !== issuerName ? [issuerAlias] : [],
      });
    }

    // Save back to Drive
    const session = await auth();
    const accessToken = (session as any)?.accessToken;
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileID}?uploadType=media&supportsAllDrives=true`;

    const writeRes = await fetch(uploadUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bibleData, null, 2),
    });

    if (!writeRes.ok) throw new Error("Failed to update Bible file on Drive");
    return { status: "UPDATED", issuerName, issuerAlias };
  }

  private static _resolveLocalPath(source: string) {
    const looksLikeDriveId = /^[a-zA-Z0-9_-]{10,}$/.test(source) && !source.includes("/");
    if (looksLikeDriveId || source.startsWith("http")) return null;

    return path.isAbsolute(source) ? source : path.join(process.cwd(), source);
  }
}
