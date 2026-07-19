#!/usr/bin/env python3
# pdf-tools-mcp.py
# PyMuPDF(fitz) 기반의 PDF 도구를 노출하는 stdio MCP 서버.
# 표준 라이브러리 + 이미 설치된 fitz 만 사용하며, 외부 바이너리(poppler 등)는 쓰지 않는다.
#
# 프로토콜: MCP(JSON-RPC 2.0) over stdin/stdout, 한 줄에 한 메시지(LSP 헤더 없음).
# 봇(Claude Agent SDK)이 이 스크립트를 stdio 서버로 spawn 하면 도구가
# mcp__pdftools__pdftotext / mcp__pdftools__pdf_extract_figures 로 노출된다.
#
# 도구:
#   pdftotext            : PDF 텍스트를 추출해 .txt 파일로 저장하고 경로/요약을 반환
#   pdf_extract_figures  : PDF에 임베드된 이미지(figure)를 추출해 파일로 저장하고 목록을 반환
#
# 두 도구 모두 결과물을 디스크에 쓰고 경로를 반환한다(대용량 PDF에서 토큰 폭주 방지).
# 출력 디렉터리 기본값은 PDF 옆 "<stem>.pdftools/" 이며 output_dir 로 덮어쓸 수 있다.

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any

try:
    import fitz  # PyMuPDF
except Exception as exc:  # pragma: no cover - 환경 의존
    fitz = None
    _FITZ_IMPORT_ERROR = exc
else:
    _FITZ_IMPORT_ERROR = None

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "pdftools"
SERVER_VERSION = "1.0.0"

# 한 번에 인라인으로 반환할 텍스트 최대 길이(이를 넘으면 파일 경로만 안내).
INLINE_TEXT_LIMIT = 20000


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(f"[pdf-tools-mcp] {message}", file=sys.stderr, flush=True)


# ---- 도구 스키마 -------------------------------------------------------------

TOOLS: list[dict[str, Any]] = [
    {
        "name": "pdftotext",
        "description": (
            "PDF에서 텍스트를 추출한다. 결과를 .txt 파일로 저장하고 저장 경로와 "
            "페이지 수, (짧으면) 본문 일부를 반환한다. 외부 바이너리 없이 PyMuPDF로 처리한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "PDF 파일의 절대 경로."},
                "output_dir": {
                    "type": "string",
                    "description": "텍스트를 저장할 디렉터리. 생략 시 PDF 옆 '<stem>.pdftools/'.",
                },
                "pages": {
                    "type": "string",
                    "description": "추출할 페이지 범위(1-기반). 예 '1-5', '2,4,6', '3-'. 생략 시 전체.",
                },
                "layout": {
                    "type": "boolean",
                    "description": "true면 페이지의 시각적 배치를 보존(blocks 정렬). 기본 false(읽기 순서).",
                },
            },
            "required": ["path"],
        },
    },
    {
        "name": "pdf_extract_figures",
        "description": (
            "PDF에 임베드된 이미지(figure/그림)를 추출해 PNG로 저장한다. 저장된 "
            "파일 경로 목록과 페이지·크기 메타데이터를 반환한다. PyMuPDF로 처리한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "PDF 파일의 절대 경로."},
                "output_dir": {
                    "type": "string",
                    "description": "이미지를 저장할 디렉터리. 생략 시 PDF 옆 '<stem>.pdftools/figures/'.",
                },
                "pages": {
                    "type": "string",
                    "description": "추출할 페이지 범위(1-기반). 예 '1-5', '2,4'. 생략 시 전체.",
                },
                "min_width": {
                    "type": "integer",
                    "description": "이 픽셀 너비 미만 이미지는 건너뛴다(아이콘/로고 잡음 제거). 기본 0.",
                },
                "min_height": {
                    "type": "integer",
                    "description": "이 픽셀 높이 미만 이미지는 건너뛴다. 기본 0.",
                },
                "render_pages": {
                    "type": "boolean",
                    "description": (
                        "true면 임베드 이미지 대신 각 페이지 전체를 PNG로 렌더링한다(벡터 그림/"
                        "복합 figure에 유용). 기본 false."
                    ),
                },
                "dpi": {
                    "type": "integer",
                    "description": "render_pages=true일 때 렌더 해상도(DPI). 기본 150.",
                },
                "return_base64": {
                    "type": "boolean",
                    "description": "true면 저장과 함께 base64 데이터도 반환(작은 이미지에만 권장). 기본 false.",
                },
            },
            "required": ["path"],
        },
    },
]


# ---- 공통 헬퍼 ---------------------------------------------------------------


def parse_page_range(spec: str | None, page_count: int) -> list[int]:
    """'1-5', '2,4,6', '3-' 같은 1-기반 명세를 0-기반 페이지 인덱스 목록으로 변환한다."""
    if not spec or not spec.strip():
        return list(range(page_count))
    indices: list[int] = []
    for part in spec.split(","):
        token = part.strip()
        if not token:
            continue
        if "-" in token:
            lo_str, hi_str = token.split("-", 1)
            lo = int(lo_str) if lo_str.strip() else 1
            hi = int(hi_str) if hi_str.strip() else page_count
        else:
            lo = hi = int(token)
        lo = max(1, lo)
        hi = min(page_count, hi)
        for p in range(lo, hi + 1):
            indices.append(p - 1)
    # 중복 제거 + 정렬
    seen: set[int] = set()
    ordered: list[int] = []
    for idx in indices:
        if 0 <= idx < page_count and idx not in seen:
            seen.add(idx)
            ordered.append(idx)
    return ordered


def resolve_pdf(path_str: str) -> Path:
    path = Path(path_str).expanduser()
    if not path.is_absolute():
        path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(f"PDF를 찾을 수 없습니다: {path}")
    if not path.is_file():
        raise ValueError(f"파일이 아닙니다: {path}")
    return path


def text_result(payload: dict[str, Any]) -> dict[str, Any]:
    """MCP tools/call 성공 결과(텍스트 콘텐츠)를 구성한다."""
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}
        ]
    }


def error_result(message: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    }


# ---- 도구 구현 ---------------------------------------------------------------


def tool_pdftotext(args: dict[str, Any]) -> dict[str, Any]:
    pdf_path = resolve_pdf(str(args.get("path", "")))
    layout = bool(args.get("layout", False))
    out_dir = Path(
        str(args["output_dir"]).strip()
    ) if args.get("output_dir") else pdf_path.with_suffix(".pdftools")
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    try:
        pages = parse_page_range(args.get("pages"), doc.page_count)
        mode = "blocks" if layout else "text"
        chunks: list[str] = []
        for idx in pages:
            page = doc.load_page(idx)
            if mode == "blocks":
                blocks = page.get_text("blocks")
                # blocks: (x0, y0, x1, y1, text, block_no, block_type)
                blocks.sort(key=lambda b: (round(b[1], 1), round(b[0], 1)))
                page_text = "\n".join(b[4] for b in blocks if isinstance(b[4], str))
            else:
                page_text = page.get_text("text")
            chunks.append(page_text)
        full_text = "\n\f\n".join(chunks)
    finally:
        doc.close()

    out_file = out_dir / f"{pdf_path.stem}.txt"
    out_file.write_text(full_text, encoding="utf-8")

    payload: dict[str, Any] = {
        "ok": True,
        "pdf": str(pdf_path),
        "text_file": str(out_file),
        "pages_extracted": len(pages),
        "char_count": len(full_text),
    }
    if len(full_text) <= INLINE_TEXT_LIMIT:
        payload["text"] = full_text
    else:
        payload["text_preview"] = full_text[:2000]
        payload["note"] = (
            f"본문이 {len(full_text)}자로 길어 인라인 생략. 전체는 text_file 경로를 읽으세요."
        )
    return text_result(payload)


def tool_pdf_extract_figures(args: dict[str, Any]) -> dict[str, Any]:
    pdf_path = resolve_pdf(str(args.get("path", "")))
    render_pages = bool(args.get("render_pages", False))
    min_w = int(args.get("min_width", 0) or 0)
    min_h = int(args.get("min_height", 0) or 0)
    dpi = int(args.get("dpi", 150) or 150)
    return_b64 = bool(args.get("return_base64", False))

    base_dir = Path(
        str(args["output_dir"]).strip()
    ) if args.get("output_dir") else pdf_path.with_suffix(".pdftools") / "figures"
    base_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    saved: list[dict[str, Any]] = []
    skipped = 0
    try:
        pages = parse_page_range(args.get("pages"), doc.page_count)
        for idx in pages:
            page = doc.load_page(idx)
            page_no = idx + 1
            if render_pages:
                pix = page.get_pixmap(dpi=dpi)
                out_file = base_dir / f"page-{page_no:03d}.png"
                pix.save(out_file)
                entry: dict[str, Any] = {
                    "file": str(out_file),
                    "page": page_no,
                    "width": pix.width,
                    "height": pix.height,
                    "kind": "rendered_page",
                }
                if return_b64:
                    entry["base64"] = base64.b64encode(out_file.read_bytes()).decode("ascii")
                saved.append(entry)
                continue
            # 임베드 이미지 추출
            for img_index, img in enumerate(page.get_images(full=True), start=1):
                xref = img[0]
                try:
                    pix = fitz.Pixmap(doc, xref)
                except Exception:
                    continue
                # CMYK/알파 등은 RGB로 변환해 PNG 저장 호환성 확보
                if pix.n - pix.alpha >= 4:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                if pix.width < min_w or pix.height < min_h:
                    skipped += 1
                    pix = None
                    continue
                out_file = base_dir / f"page-{page_no:03d}-img-{img_index:02d}.png"
                pix.save(out_file)
                entry = {
                    "file": str(out_file),
                    "page": page_no,
                    "width": pix.width,
                    "height": pix.height,
                    "kind": "embedded_image",
                    "xref": xref,
                }
                if return_b64:
                    entry["base64"] = base64.b64encode(out_file.read_bytes()).decode("ascii")
                saved.append(entry)
                pix = None
    finally:
        doc.close()

    payload = {
        "ok": True,
        "pdf": str(pdf_path),
        "output_dir": str(base_dir),
        "count": len(saved),
        "skipped_small": skipped,
        "mode": "rendered_pages" if render_pages else "embedded_images",
        "figures": saved,
    }
    return text_result(payload)


TOOL_IMPL = {
    "pdftotext": tool_pdftotext,
    "pdf_extract_figures": tool_pdf_extract_figures,
}


# ---- JSON-RPC 디스패치 -------------------------------------------------------


def handle_request(msg: dict[str, Any]) -> dict[str, Any] | None:
    method = msg.get("method")
    msg_id = msg.get("id")

    # 알림(notification)은 id가 없다 — 응답하지 않는다.
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
        if fitz is None:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": error_result(
                    f"PyMuPDF(fitz)를 불러올 수 없습니다: {_FITZ_IMPORT_ERROR}"
                ),
            }
        try:
            result = impl(arguments)
        except Exception as exc:  # 도구 오류는 isError 결과로 모델에 전달
            log(f"tool '{name}' 실패: {exc}")
            return {"jsonrpc": "2.0", "id": msg_id, "result": error_result(str(exc))}
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    # ping 등 그 외 표준 메서드
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
    if fitz is None:
        log(f"경고: PyMuPDF import 실패 — 도구 호출 시 오류를 반환합니다: {_FITZ_IMPORT_ERROR}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            response = handle_request(msg)
        except Exception as exc:  # 디스패치 자체 실패 — 치명적이지 않게 보고
            log(f"디스패치 오류: {exc}")
            msg_id = msg.get("id") if isinstance(msg, dict) else None
            if msg_id is not None:
                emit({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(exc)}})
            continue
        if response is not None:
            emit(response)


if __name__ == "__main__":
    main()
