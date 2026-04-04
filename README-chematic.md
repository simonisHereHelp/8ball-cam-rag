# Photo Workflow Schematic

## OpenAI Path

```text
[Summarize]
  -> /api/extract-advanced
  -> extract_output
  -> [Ingest]
  -> /api/ingest
  -> ingest_output
```

## HF Path

```text
[Summarize-HF]
  -> /api/extract-hf
  -> extract_output
  -> [Ingest-HF]
  -> /api/ingest-hf
  -> ingest_output
```

## Shared Save Path

```text
ingest_output / edited ingest-image-output.json
  -> [Save to Drive]
  -> /api/save-set
  -> Active Directory:
     .json + .md + images
```

## Notes

- Saved filenames use no spaces.
- Save output naming convention is based on:
  `issuer_name-doc_class-action_in_verb-documentDate`
- The saved `.md` includes:
  `## Meta`, `## Raw Text`, `## JSON Reference`, and `## Images`
