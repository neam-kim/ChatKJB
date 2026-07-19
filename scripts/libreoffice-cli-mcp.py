#!/usr/bin/env python3
"""Expose LibreOffice headless CLI conversion as a small stdio MCP server."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote


PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "libreoffice-cli"
SERVER_VERSION = "1.0.0"
DEFAULT_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
DEFAULT_TIMEOUT_SECONDS = 120
MAX_TIMEOUT_SECONDS = 600


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(f"[libreoffice-cli-mcp] {message}", file=sys.stderr, flush=True)


def text_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}
        ]
    }


def error_result(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def soffice_path() -> Path:
    configured = os.environ.get("SOFFICE_PATH", DEFAULT_SOFFICE)
    path = Path(configured).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"LibreOffice CLI를 찾을 수 없습니다: {path}")
    if not path.is_file():
        raise ValueError(f"LibreOffice CLI 경로가 파일이 아닙니다: {path}")
    return path


def resolve_file(path_value: str) -> Path:
    path = Path(path_value).expanduser()
    if not path.is_absolute():
        path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {path}")
    if not path.is_file():
        raise ValueError(f"입력 경로가 파일이 아닙니다: {path}")
    return path


def resolve_output_dir(input_path: Path, output_dir: str | None) -> Path:
    if output_dir and str(output_dir).strip():
        path = Path(str(output_dir)).expanduser()
        if not path.is_absolute():
            path = path.resolve()
    else:
        path = input_path.with_suffix(".libreoffice")
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise ValueError(f"출력 경로가 디렉터리가 아닙니다: {path}")
    return path


def timeout_seconds(value: Any) -> int:
    try:
        seconds = int(value or DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        seconds = DEFAULT_TIMEOUT_SECONDS
    return max(1, min(seconds, MAX_TIMEOUT_SECONDS))


def profile_arg(profile_dir: Path) -> str:
    # LibreOffice expects a file URL. Quote spaces and non-ASCII path parts.
    return "-env:UserInstallation=file://" + quote(str(profile_dir))


def run_soffice(args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    command = [str(soffice_path()), *args]
    return subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )


TOOLS: list[dict[str, Any]] = [
    {
        "name": "libreoffice_info",
        "description": "설치된 LibreOffice CLI 경로와 버전을 확인한다.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "libreoffice_convert",
        "description": (
            "LibreOffice headless CLI로 문서를 다른 형식으로 변환한다. 예: docx/pptx/xlsx/odt/odp/ods/txt "
            "입력을 pdf/html/txt/docx/pptx/xlsx 등 LibreOffice가 지원하는 형식으로 변환한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "input_path": {"type": "string", "description": "변환할 입력 파일의 절대 경로."},
                "to_format": {
                    "type": "string",
                    "description": "LibreOffice --convert-to 형식. 예: pdf, html, txt, docx, pptx, xlsx.",
                },
                "output_dir": {
                    "type": "string",
                    "description": "출력 디렉터리. 생략 시 입력 파일 옆 '<stem>.libreoffice/'.",
                },
                "filter_options": {
                    "type": "string",
                    "description": "필요 시 LibreOffice 필터 옵션까지 포함한 convert-to 값. 지정하면 to_format 대신 사용.",
                },
                "timeout_seconds": {
                    "type": "integer",
                    "description": f"변환 제한 시간. 기본 {DEFAULT_TIMEOUT_SECONDS}초, 최대 {MAX_TIMEOUT_SECONDS}초.",
                },
            },
            "required": ["input_path", "to_format"],
        },
    },
]


def tool_libreoffice_info(_: dict[str, Any]) -> dict[str, Any]:
    completed = run_soffice(["--version"], DEFAULT_TIMEOUT_SECONDS)
    return text_result(
        {
            "ok": completed.returncode == 0,
            "soffice_path": str(soffice_path()),
            "returncode": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
        }
    )


def tool_libreoffice_convert(args: dict[str, Any]) -> dict[str, Any]:
    input_path = resolve_file(str(args.get("input_path", "")))
    output_dir = resolve_output_dir(input_path, args.get("output_dir"))
    convert_to = str(args.get("filter_options") or args.get("to_format") or "").strip()
    if not convert_to:
        raise ValueError("to_format 또는 filter_options가 필요합니다.")
    timeout = timeout_seconds(args.get("timeout_seconds"))

    before = {path.name for path in output_dir.iterdir()} if output_dir.exists() else set()
    with tempfile.TemporaryDirectory(prefix="libreoffice-cli-profile-") as profile:
        completed = run_soffice(
            [
                "--headless",
                "--nologo",
                "--nofirststartwizard",
                "--norestore",
                profile_arg(Path(profile)),
                "--convert-to",
                convert_to,
                "--outdir",
                str(output_dir),
                str(input_path),
            ],
            timeout,
        )

    after = list(output_dir.iterdir())
    new_files = [path for path in after if path.name not in before]
    if not new_files:
        stem_matches = [path for path in after if path.stem == input_path.stem]
        new_files = stem_matches

    payload = {
        "ok": completed.returncode == 0 and bool(new_files),
        "input_path": str(input_path),
        "output_dir": str(output_dir),
        "convert_to": convert_to,
        "returncode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
        "output_files": [
            {"path": str(path), "bytes": path.stat().st_size}
            for path in sorted(new_files)
            if path.exists() and path.is_file()
        ],
    }
    if completed.returncode != 0 or not new_files:
        payload["note"] = "LibreOffice가 성공 코드를 반환하지 않았거나 새 출력 파일을 찾지 못했습니다."
    return text_result(payload)


TOOL_IMPL = {
    "libreoffice_info": tool_libreoffice_info,
    "libreoffice_convert": tool_libreoffice_convert,
}


def handle_request(msg: dict[str, Any]) -> dict[str, Any] | None:
    method = msg.get("method")
    msg_id = msg.get("id")

    if method == "notifications/initialized" or (method and method.startswith("notifications/")):
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        }

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        impl = TOOL_IMPL.get(name)
        if impl is None:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Unknown tool: {name}"},
            }
        try:
            result = impl(arguments)
        except subprocess.TimeoutExpired as exc:
            log(f"tool '{name}' 제한 시간 초과: {exc}")
            result = error_result(f"LibreOffice 제한 시간 초과: {exc}")
        except Exception as exc:
            log(f"tool '{name}' 실패: {exc}")
            result = error_result(str(exc))
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if msg_id is not None:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    return None


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = handle_request(msg)
        if response is not None:
            emit(response)


if __name__ == "__main__":
    main()
