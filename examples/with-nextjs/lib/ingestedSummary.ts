export interface IngestedSummary {
  file_group_id: string;
  subject_category: string;
  doc_class: string;
  doc_date: string;
  issuer_name: string;
  issuer_alias: string;
  title: string;
  summary: string;
  actionable_in_verb: string;
}

const normalizeLine = (value: string) => value.replace(/\r/g, "").trim();

const findSectionBody = (markdown: string, heading: string) => {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const target = heading.trim().toLowerCase();

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().toLowerCase() !== target) continue;

    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (/^##\s+/.test(candidate.trim())) break;
      body.push(candidate);
    }
    return body.join("\n").trim();
  }

  return "";
};

const parseMetaSection = (markdown: string) => {
  const metaBody = findSectionBody(markdown, "## Meta");
  const entries = new Map<string, string>();

  metaBody
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^-\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (!match) return;
      entries.set(match[1].trim().toLowerCase(), match[2].trim());
    });

  return entries;
};

const extractFileGroupId = (markdown: string) => {
  const match = markdown.replace(/\r/g, "").match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || "";
};

const extractDocumentTitle = (markdown: string, fallbackTitle: string) => {
  const lines = markdown.replace(/\r/g, "").split("\n");
  let seenDivider = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "---") {
      seenDivider = true;
      continue;
    }
    if (!seenDivider) continue;
    if (/^#\s+/.test(line)) {
      return line.replace(/^#\s+/, "").trim();
    }
  }

  return fallbackTitle;
};

const extractSummaryText = (markdown: string) =>
  findSectionBody(markdown, "## Summary")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .join(" ");

export const buildIngestedSummary = (markdown: string): IngestedSummary => {
  const meta = parseMetaSection(markdown);
  const fileGroupId = extractFileGroupId(markdown);

  return {
    file_group_id: fileGroupId,
    subject_category: meta.get("subject_category") || "",
    doc_class: meta.get("doc_class") || "",
    doc_date: meta.get("date") || "",
    issuer_name: meta.get("issuer_name") || "",
    issuer_alias: meta.get("issuer_alias") || "",
    title: extractDocumentTitle(markdown, fileGroupId),
    summary: extractSummaryText(markdown),
    actionable_in_verb: meta.get("action_in_verb") || "",
  };
};
