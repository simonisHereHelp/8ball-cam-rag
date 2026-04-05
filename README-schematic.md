# Photo Workflow Schematic

## Main Flow

```text
[OCR]
  -> /api/extract-advanced
  -> extract_output
  -> [Ingest]
  -> /api/ingest
  -> ingest_output
  -> [Save to Drive]
  -> /api/save-set
  -> Active Directory:
     .json + .md + images
```

## Route Notes

- `/api/extract-advanced` forwards images plus prompt data to `PADDLE_OCR_URL + "/extract"`.
- `/api/ingest` forwards `extract_output` plus canon prompt data to `PADDLE_OCR_URL + "/ingest"`.
- `/api/save-set` saves the final JSON, markdown, and page images to Drive.

## Notes

- Saved filenames use no spaces.
- Save output naming convention is based on:
  `issuer_name-doc_class-action_in_verb-documentDate`
- The saved `.md` includes:
  `## Meta`, `## Raw Text`, `## JSON Reference`, and `## Images`
