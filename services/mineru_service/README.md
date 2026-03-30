# MinerU Service

This service is the Lenovo-side Python endpoint for the Next.js route:

- Vercel/Next.js calls `MINERU_SERVICE_URL`
- this service receives multipart uploads plus `systemPrompt` and `userPrompt`
- it runs MinerU locally
- it optionally rewrites MinerU's raw markdown into the app's final markdown shape using an OpenAI-compatible chat completion

## Endpoints

- `GET /healthz`
- `POST /extract`

`POST /extract` accepts:

- `Authorization: Bearer <token>` when `MINERU_SERVICE_BEARER_TOKEN` is set
- multipart file fields named `image` and/or `files`
- form fields `systemPrompt` and `userPrompt`

It returns JSON shaped like:

```json
{
  "markdown": "...final markdown...",
  "plainText": "...flattened text...",
  "title": "...",
  "abstract": "...",
  "pages": [
    {
      "page": 1,
      "markdown": "...page markdown...",
      "plainText": "...",
      "contentList": [],
      "imagePath": "./page-01.png"
    }
  ]
}
```

## Installation

MinerU's official docs currently recommend Python 3.10-3.13, and on Windows they note 3.10-3.12 support because of `ray` compatibility. They also recommend installing with:

```bash
pip install --upgrade pip
pip install uv
uv pip install -U "mineru[all]"
```

This service itself needs:

```bash
pip install -r requirements.txt
```

Official references:

- [MinerU quick start](https://opendatalab.github.io/MinerU/quick_start/)
- [MinerU quick usage](https://opendatalab.github.io/MinerU/usage/quick_usage/)
- [MinerU CLI tools](https://opendatalab.github.io/MinerU/usage/cli_tools/)
- [MinerU output files](https://opendatalab.github.io/MinerU/reference/output_files/)

## Suggested env

```env
MINERU_SERVICE_BEARER_TOKEN=your-own-long-random-secret
MINERU_BIN=mineru
MINERU_METHOD=ocr
MINERU_BACKEND=pipeline
MINERU_LANG=chinese_cht
MINERU_DEVICE=cuda
MINERU_ENABLE_LLM_REWRITE=true

OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TIMEOUT_SECONDS=120
```

Notes:

- `MINERU_BACKEND=pipeline` is a conservative default.
- `MINERU_DEVICE=cuda` is suitable if the Lenovo GPU setup is working.
- If you want raw MinerU output only, set `MINERU_ENABLE_LLM_REWRITE=false`.

## Run

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

Then your Vercel env can point to:

```env
MINERU_SERVICE_URL=https://lenovo.ishere.help/extract
```

assuming your Cloudflare tunnel maps `lenovo.ishere.help` to this service.

## Windows / WSL

This service code works in either:

- native Windows Python
- WSL2 Ubuntu

For MinerU itself, WSL2 is often the smoother option if native Windows dependency issues show up. MinerU's FAQ specifically mentions WSL font and `libGL` issues on Ubuntu and how to fix them, which is helpful if you go that route:

- [MinerU FAQ](https://opendatalab.github.io/MinerU/faq/)
