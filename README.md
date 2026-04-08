# 8ball Cam RAG

Camera-first document capture flow built on `react-web-camera`, a Next.js example app, and a Hugging Face OCR service.

## Current app flow

1. Capture or pick one or more images.
2. `OCR` posts images to `/api/extract-advanced`.
3. `/api/extract-advanced` loads prompt/canon JSON and forwards the request to `PADDLE_OCR_URL + "/extract"`.
4. `Ingest` posts `extract_output` to `/api/ingest`.
5. `/api/ingest` keeps the existing canon prompt block and forwards the request to `QWEN_HF_URL + "/ingest"`.
6. `Save to Drive` uploads the derived markdown, JSON, and images through `/api/save-set`.

## Active routes

- `/api/extract-advanced`
- `/api/ingest`
- `/api/save-set`
- `/api/issuer-canons`
- `/api/active-subfolders`

## Prompt and canon sources

The Next.js app reads JSON config from Drive IDs or direct JSON URLs, with env resolution handled by `examples/with-nextjs/lib/jsonCanonSources.ts`.

Main sources:

- `prompt_extract.json`
- `canonicals_bible.json`
- `subjectCat_docClass_actionVerb.json`
- `drive_active_subfolders.json`

The shared prompt loader is `examples/with-nextjs/lib/jsonPromptLoader.ts`.

## Environment

Required app env:

- `PADDLE_OCR_URL`
- `PADDLE_OCR_BEARER_TOKEN`
- `QWEN_HF_URL`
- `QWEN_HF_TOKEN`
- `DRIVE_FOLDER_ID`

Optional:

- `DRIVE_FALLBACK_FOLDER_ID`
- prompt/canon source env vars from `jsonCanonSources.ts`
- `PADDLE_OCR_TIMEOUT_MS`
- `QWEN_HF_TIMEOUT_MS`

## Notes

- The app now uses separate backends: Paddle OCR for extraction and Qwen HF for ingest.
- Save file naming is derived from `issuer_name`, `doc_class`, `action_in_verb`, and `documentDate`.
- Issuer canons are still loaded for manual selection in the UI.
