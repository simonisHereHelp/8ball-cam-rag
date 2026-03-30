from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse


app = FastAPI(title="MinerU Extraction Service", version="0.1.0")


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_expected_token() -> str:
    return os.getenv("MINERU_SERVICE_BEARER_TOKEN", "").strip()


def require_auth(authorization: str | None) -> None:
    expected = get_expected_token()
    if not expected:
        return

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token.")

    token = authorization.removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(status_code=401, detail="Invalid bearer token.")


def sanitize_filename(name: str, fallback_index: int) -> str:
    raw_name = Path(name or "").name
    if not raw_name:
        return f"page-{fallback_index:02d}.png"

    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", raw_name).strip("-")
    return safe_name or f"page-{fallback_index:02d}.png"


def strip_markdown(markdown: str) -> str:
    text = re.sub(r"```.*?```", "", markdown, flags=re.S)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^#+\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def find_first_markdown(output_dir: Path) -> str:
    markdown_files = sorted(
        [path for path in output_dir.rglob("*.md") if path.is_file()],
        key=lambda path: len(path.read_text(encoding="utf-8", errors="ignore")),
        reverse=True,
    )

    if not markdown_files:
        raise RuntimeError(f"No markdown output found in {output_dir}")

    return markdown_files[0].read_text(encoding="utf-8", errors="ignore").strip()


def find_content_list(output_dir: Path) -> list[dict[str, Any]] | None:
    matches = sorted(output_dir.rglob("*content_list.json"))
    if not matches:
        return None

    try:
        return json.loads(matches[0].read_text(encoding="utf-8"))
    except Exception:
        return None


def run_mineru(input_path: Path, output_dir: Path) -> dict[str, Any]:
    mineru_bin = os.getenv("MINERU_BIN", "mineru").strip() or "mineru"
    method = os.getenv("MINERU_METHOD", "ocr").strip() or "ocr"
    backend = os.getenv("MINERU_BACKEND", "pipeline").strip() or "pipeline"
    lang = os.getenv("MINERU_LANG", "").strip()
    device = os.getenv("MINERU_DEVICE", "").strip()

    command = [
        mineru_bin,
        "-p",
        str(input_path),
        "-o",
        str(output_dir),
        "-m",
        method,
        "-b",
        backend,
    ]

    if lang:
        command.extend(["-l", lang])

    if device:
        command.extend(["-d", device])

    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )

    if completed.returncode != 0:
        raise RuntimeError(
            "MinerU command failed.\n"
            f"Command: {' '.join(command)}\n"
            f"STDOUT:\n{completed.stdout}\n\nSTDERR:\n{completed.stderr}"
        )

    markdown = find_first_markdown(output_dir)
    content_list = find_content_list(output_dir)

    return {
        "markdown": markdown,
        "content_list": content_list,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def build_combined_markdown(page_files: list[Path], page_results: list[dict[str, Any]]) -> str:
    image_lines = []
    page_sections = []

    for index, (file_path, page_result) in enumerate(zip(page_files, page_results), start=1):
        image_path = f"./{file_path.name}"
        image_lines.append(f"![page-{index}]({image_path})")
        page_sections.append(
            "\n".join(
                [
                    f"## Page {index}",
                    "",
                    f"![page-{index}]({image_path})",
                    "",
                    page_result["markdown"].strip(),
                ]
            ).strip()
        )

    return "\n\n".join(
        [
            "## Images",
            "",
            "\n".join(image_lines),
            "",
            "---",
            "",
            "\n\n---\n\n".join(page_sections),
        ]
    ).strip()


async def maybe_rewrite_markdown(
    raw_markdown: str,
    system_prompt: str,
    user_prompt: str,
) -> str:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return raw_markdown

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")

    instructions = (
        f"{user_prompt}\n\n"
        "以下是由 MinerU 先行抽取的原始 Markdown 與逐頁內容。"
        "請依照前述規則，整理為最終 Markdown。"
        "請務必保留圖片相對路徑、頁面順序與可見證據，不可虛構。\n\n"
        f"{raw_markdown}"
    )

    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": instructions},
        ],
    }

    timeout_seconds = float(os.getenv("OPENAI_TIMEOUT_SECONDS", "120"))

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if response.status_code >= 400:
        raise RuntimeError(f"OpenAI rewrite failed: {response.status_code} {response.text}")

    data = response.json()
    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
        .strip()
    )
    return content or raw_markdown


def extract_title(markdown: str) -> str:
    for line in markdown.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def extract_summary(markdown: str) -> str:
    lines = markdown.splitlines()
    for index, line in enumerate(lines):
        if line.strip().lower() == "## summary":
            body = []
            for candidate in lines[index + 1 :]:
                stripped = candidate.strip()
                if stripped.startswith("## "):
                    break
                body.append(candidate)
            return "\n".join(body).strip()
    return ""


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/extract")
async def extract(
    authorization: str | None = Header(default=None),
    image: list[UploadFile] | None = File(default=None),
    files: list[UploadFile] | None = File(default=None),
    systemPrompt: str = Form(default=""),
    userPrompt: str = Form(default=""),
) -> JSONResponse:
    require_auth(authorization)

    uploads = [*(image or []), *(files or [])]
    if not uploads:
        raise HTTPException(status_code=400, detail="At least one file is required.")

    with tempfile.TemporaryDirectory(prefix="mineru-service-") as temp_dir:
        work_dir = Path(temp_dir)
        input_dir = work_dir / "input"
        output_dir = work_dir / "output"
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        saved_files: list[Path] = []
        page_results: list[dict[str, Any]] = []

        for index, upload in enumerate(uploads, start=1):
            extension = Path(upload.filename or "").suffix or ".png"
            safe_name = sanitize_filename(upload.filename or f"page-{index:02d}{extension}", index)
            if Path(safe_name).suffix == "":
                safe_name = f"{safe_name}{extension}"

            destination = input_dir / safe_name
            with destination.open("wb") as handle:
                shutil.copyfileobj(upload.file, handle)
            saved_files.append(destination)

            page_output_dir = output_dir / f"page-{index:02d}"
            page_output_dir.mkdir(parents=True, exist_ok=True)
            page_results.append(run_mineru(destination, page_output_dir))

        raw_markdown = build_combined_markdown(saved_files, page_results)
        final_markdown = raw_markdown

        if systemPrompt.strip() and userPrompt.strip() and env_flag("MINERU_ENABLE_LLM_REWRITE", True):
            final_markdown = await maybe_rewrite_markdown(raw_markdown, systemPrompt, userPrompt)

        payload = {
            "markdown": final_markdown,
            "plainText": strip_markdown(final_markdown),
            "title": extract_title(final_markdown),
            "abstract": extract_summary(final_markdown),
            "pages": [
                {
                    "page": index,
                    "markdown": page_result["markdown"],
                    "plainText": strip_markdown(page_result["markdown"]),
                    "contentList": page_result.get("content_list"),
                    "imagePath": f"./{file_path.name}",
                }
                for index, (file_path, page_result) in enumerate(zip(saved_files, page_results), start=1)
            ],
        }

        return JSONResponse(payload)
