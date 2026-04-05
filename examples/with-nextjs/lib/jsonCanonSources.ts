const requireJsonSource = (
  label: string,
  ...candidates: Array<string | undefined>
) => {
  const resolved = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
  if (!resolved) {
    throw new Error(`Missing source for ${label}. Configure a Drive ID or URL in environment variables.`);
  }

  return resolved.trim();
};

export const PROMPT_SUMMARY_SOURCE = requireJsonSource(
  "PROMPT_SUMMARY_SOURCE",
  process.env.PROMPT_SUMMARY_JSON_PATH,
  process.env.PROMPT_SUMMARY_JSON_ID,
);

export const PROMPT_EXTRACT_SOURCE = requireJsonSource(
  "PROMPT_EXTRACT_SOURCE",
  process.env.PROMPT_EXTRACT_JSON_PATH,
  process.env.PROMPT_EXTRACT_JSON_ID,
);

export const SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE = requireJsonSource(
  "SUBJECT_CAT_DOC_CLASS_ACTION_SOURCE",
  process.env.SUBJECT_CAT_DOC_CLASS_ACTION_PATH,
  process.env.SUBJECT_CAT_DOC_CLASS_ACTION_ID,
);

export const PROMPT_ISSUER_CANON_SOURCE = requireJsonSource(
  "PROMPT_ISSUER_CANON_SOURCE",
  process.env.PROMPT_ISSUER_CANON_JSON_PATH,
  process.env.PROMPT_ISSUER_CANON_JSON_ID,
);

export const PROMPT_SET_NAME_SOURCE = requireJsonSource(
  "PROMPT_SET_NAME_SOURCE",
  process.env.PROMPT_SET_NAME_JSON_PATH,
  process.env.PROMPT_SET_NAME_JSON_ID,
);

export const PROMPT_DESIGNATED_SUBFOLDER_SOURCE = requireJsonSource(
  "PROMPT_DESIGNATED_SUBFOLDER_SOURCE",
  process.env.PROMPT_DESIGNATED_SUBFOLDER,
  process.env.PROMPT_DESIGNATED_SUBFOLDER_ID,
);

export const DRIVE_ACTIVE_SUBFOLDER_SOURCE = requireJsonSource(
  "DRIVE_ACTIVE_SUBFOLDER_SOURCE",
  process.env.DRIVE_ACTIVE_SUBFOLDER_PATH,
  process.env.DRIVE_ACTIVE_SUBFOLDER_ID,
);

export const DRIVE_FALLBACK_FOLDER_ID =
  process.env.DRIVE_FALLBACK_FOLDER_ID || process.env.DRIVE_FOLDER_ID;

export const CANONICALS_BIBLE_SOURCE = requireJsonSource(
  "CANONICALS_BIBLE_SOURCE",
  process.env.CANONICALS_BIBLE_JSON_PATH,
  process.env.DRIVE_FILE_ID_CANONICALS,
);
