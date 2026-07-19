#!/usr/bin/env python3
"""Sci-Hub paper resolution / PDF download MCP server for ChatKJB.

Resolves academic identifiers (DOI, PMID, publisher URL) against configurable
Sci-Hub mirrors, returns citation metadata when present, and optionally saves
the PDF to disk. Uses only the Python standard library.

Copyright notice: Sci-Hub redistributes publisher-hosted content. Callers are
responsible for complying with applicable copyright and access rules in their
jurisdiction. Prefer open-access sources when available.
"""

from __future__ import annotations

import html as html_lib
import json
import os
import re
import ssl
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "scihub"
SERVER_VERSION = "1.0.0"

HTTP_TIMEOUT_SECONDS = int(os.environ.get("SCIHUB_HTTP_TIMEOUT", "30"))
MAX_HTML_BYTES = 8 * 1024 * 1024
MAX_PDF_BYTES = int(os.environ.get("SCIHUB_MAX_PDF_BYTES", str(80 * 1024 * 1024)))
MAX_IDENTIFIER_CHARS = 2000

DEFAULT_MIRRORS = [
    "https://sci-hub.ru",
    "https://sci-hub.red",
    "https://sci-hub.box",
    "https://sci-hub.st",
]

USER_AGENT = os.environ.get(
    "SCIHUB_USER_AGENT",
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
)

DEFAULT_OUTPUT_DIR = os.environ.get(
    "SCIHUB_OUTPUT_DIR",
    str(Path.home() / "Downloads" / "scihub"),
)

_SSL_CONTEXT = ssl.create_default_context()

DOI_RE = re.compile(
    r"\b(10\.\d{4,9}/[^\s\"'<>]+)",
    re.IGNORECASE,
)
PMID_RE = re.compile(r"\bPMID[:\s]*(\d{1,12})\b", re.IGNORECASE)
BARE_PMID_RE = re.compile(r"^\d{1,12}$")
META_RE = re.compile(
    r"<meta\b[^>]*\bname\s*=\s*[\"']([^\"']+)[\"'][^>]*\bcontent\s*=\s*[\"']([^\"']*)[\"'][^>]*/?>",
    re.IGNORECASE,
)
META_RE_REV = re.compile(
    r"<meta\b[^>]*\bcontent\s*=\s*[\"']([^\"']*)[\"'][^>]*\bname\s*=\s*[\"']([^\"']+)[\"'][^>]*/?>",
    re.IGNORECASE,
)
STORAGE_PDF_RE = re.compile(
    r"(//[^\"'\s>]+\.pdf(?:\?[^\"'\s>]*)?|/storage/[^\"'\s>]+\.pdf(?:\?[^\"'\s>]*)?)",
    re.IGNORECASE,
)
EMBED_SRC_RE = re.compile(
    r"<(?:embed|iframe)\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)
BUTTON_ONCLICK_RE = re.compile(
    r"location\.href\s*=\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(f"[scihub-mcp] {message}", file=sys.stderr, flush=True)


def text_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}
        ]
    }


def error_result(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def configured_mirrors() -> list[str]:
    raw = os.environ.get("SCIHUB_MIRRORS", "").strip()
    if not raw:
        mirrors = list(DEFAULT_MIRRORS)
    else:
        mirrors = [part.strip().rstrip("/") for part in raw.split(",") if part.strip()]
    seen: set[str] = set()
    ordered: list[str] = []
    for mirror in mirrors:
        if not mirror.startswith("http://") and not mirror.startswith("https://"):
            mirror = "https://" + mirror
        mirror = mirror.rstrip("/")
        if mirror not in seen:
            seen.add(mirror)
            ordered.append(mirror)
    return ordered


def clean_identifier(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError("identifier는 비어 있을 수 없습니다.")
    if len(text) > MAX_IDENTIFIER_CHARS:
        raise ValueError(f"identifier는 {MAX_IDENTIFIER_CHARS}자 이하여야 합니다.")
    return text


def normalize_identifier(raw: str) -> dict[str, str]:
    """Return a query key Sci-Hub understands plus structured fields."""
    text = raw.strip()
    text = text.replace("https://doi.org/", "").replace("http://doi.org/", "")
    text = text.replace("https://dx.doi.org/", "").replace("http://dx.doi.org/", "")
    text = text.replace("doi:", "").replace("DOI:", "").strip()

    pmid_match = PMID_RE.search(text)
    if pmid_match:
        pmid = pmid_match.group(1)
        return {"query": pmid, "kind": "pmid", "pmid": pmid}

    if BARE_PMID_RE.match(text) and not text.startswith("10."):
        return {"query": text, "kind": "pmid", "pmid": text}

    doi_match = DOI_RE.search(text)
    if doi_match:
        doi = doi_match.group(1).rstrip(").,;]")
        return {"query": doi, "kind": "doi", "doi": doi}

    if text.startswith("http://") or text.startswith("https://"):
        return {"query": text, "kind": "url", "url": text}

    return {"query": text, "kind": "other"}


def browser_headers(referer: str | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        headers["Referer"] = referer
    return headers


def http_get(url: str, *, accept: str | None = None, referer: str | None = None) -> tuple[bytes, str, str]:
    headers = browser_headers(referer)
    if accept:
        headers["Accept"] = accept
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS, context=_SSL_CONTEXT) as response:
            body = response.read(MAX_PDF_BYTES + 1)
            content_type = response.headers.get("Content-Type", "") or ""
            final_url = response.geturl()
    except HTTPError as exc:
        detail = exc.read(1024).decode("utf-8", errors="replace").strip()
        suffix = f": {detail[:200]}" if detail else ""
        raise RuntimeError(f"HTTP {exc.code} from {url}{suffix}") from exc
    except URLError as exc:
        raise RuntimeError(f"연결 실패 ({url}): {exc.reason}") from exc
    if len(body) > MAX_PDF_BYTES:
        raise RuntimeError(f"응답이 허용 크기({MAX_PDF_BYTES} bytes)를 초과했습니다.")
    return body, content_type, final_url


def absolute_url(base: str, candidate: str) -> str:
    candidate = html_lib.unescape(candidate.strip())
    if candidate.startswith("//"):
        return "https:" + candidate
    if candidate.startswith("http://") or candidate.startswith("https://"):
        return candidate
    # Preserve leading "/" so root-relative paths resolve against the host.
    return urljoin(base, candidate)


def extract_meta(html: str) -> dict[str, Any]:
    meta: dict[str, list[str]] = {}
    for regex, name_idx, content_idx in (
        (META_RE, 1, 2),
        (META_RE_REV, 2, 1),
    ):
        for match in regex.finditer(html):
            name = match.group(name_idx).strip().lower()
            content = html_lib.unescape(match.group(content_idx).strip())
            if not name or not content:
                continue
            meta.setdefault(name, []).append(content)

    authors = meta.get("citation_author") or []
    title = (meta.get("citation_title") or [None])[0]
    doi = (meta.get("citation_doi") or [None])[0]
    journal = (meta.get("citation_journal_title") or [None])[0]
    date = (meta.get("citation_publication_date") or [None])[0]
    pdf_urls = meta.get("citation_pdf_url") or []
    year = None
    if isinstance(date, str) and len(date) >= 4 and date[:4].isdigit():
        year = int(date[:4])

    return {
        "title": title,
        "authors": authors,
        "doi": doi,
        "journal": journal,
        "publicationDate": date,
        "year": year,
        "pdfMetaUrls": pdf_urls,
    }


def extract_pdf_candidates(html: str, page_url: str) -> list[str]:
    candidates: list[str] = []
    meta = extract_meta(html)
    for item in meta.get("pdfMetaUrls") or []:
        candidates.append(absolute_url(page_url, str(item)))
    for match in EMBED_SRC_RE.finditer(html):
        src = match.group(1)
        if "pdf" in src.lower() or "/storage/" in src.lower() or src.endswith("#navpanes=0"):
            candidates.append(absolute_url(page_url, src.split("#", 1)[0]))
    for match in STORAGE_PDF_RE.finditer(html):
        candidates.append(absolute_url(page_url, match.group(1)))
    for match in BUTTON_ONCLICK_RE.finditer(html):
        href = match.group(1)
        if "pdf" in href.lower() or "/storage/" in href.lower():
            candidates.append(absolute_url(page_url, href.split("#", 1)[0]))

    seen: set[str] = set()
    ordered: list[str] = []
    for url in candidates:
        if url not in seen:
            seen.add(url)
            ordered.append(url)
    return ordered


def looks_like_pdf(body: bytes, content_type: str) -> bool:
    if body[:5] == b"%PDF-" or body[:4] == b"%PDF":
        return True
    lowered = content_type.lower()
    return "application/pdf" in lowered and b"%PDF" in body[:1024]


def page_indicates_missing(html: str) -> bool:
    lowered = html.lower()
    markers = [
        "article not found",
        "не найдена",
        "не найден",
        "нет статьи",
        "sorry, the article",
        "this paper is unavailable",
        "сначала загрузите",
    ]
    return any(marker in lowered for marker in markers)


def resolve_against_mirrors(identifier: str) -> dict[str, Any]:
    normalized = normalize_identifier(identifier)
    query = normalized["query"]
    attempts: list[dict[str, Any]] = []
    mirrors = configured_mirrors()
    if not mirrors:
        raise RuntimeError("사용 가능한 Sci-Hub 미러가 없습니다. SCIHUB_MIRRORS를 설정하세요.")

    for mirror in mirrors:
        page_url = f"{mirror}/{query}"
        try:
            body, content_type, final_url = http_get(
                page_url,
                accept="text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
                referer=mirror + "/",
            )
        except Exception as exc:
            attempts.append({"mirror": mirror, "ok": False, "error": str(exc)})
            continue

        if looks_like_pdf(body, content_type):
            return {
                "ok": True,
                "identifier": identifier,
                "normalized": normalized,
                "mirror": mirror,
                "pageUrl": final_url,
                "pdfUrl": final_url,
                "directPdf": True,
                "metadata": {},
                "attempts": attempts + [{"mirror": mirror, "ok": True, "mode": "direct_pdf"}],
            }

        html = body[:MAX_HTML_BYTES].decode("utf-8", errors="replace")
        if page_indicates_missing(html):
            attempts.append({"mirror": mirror, "ok": False, "error": "article not found"})
            continue

        metadata = extract_meta(html)
        pdf_candidates = extract_pdf_candidates(html, final_url or page_url)
        if not pdf_candidates:
            attempts.append(
                {
                    "mirror": mirror,
                    "ok": False,
                    "error": "HTML에서 PDF 링크를 찾지 못함",
                    "pageUrl": final_url,
                }
            )
            continue

        return {
            "ok": True,
            "identifier": identifier,
            "normalized": normalized,
            "mirror": mirror,
            "pageUrl": final_url,
            "pdfUrl": pdf_candidates[0],
            "pdfCandidates": pdf_candidates,
            "directPdf": False,
            "metadata": {
                "title": metadata.get("title"),
                "authors": metadata.get("authors") or [],
                "doi": metadata.get("doi") or normalized.get("doi"),
                "journal": metadata.get("journal"),
                "publicationDate": metadata.get("publicationDate"),
                "year": metadata.get("year"),
            },
            "attempts": attempts + [{"mirror": mirror, "ok": True, "mode": "html_embed"}],
        }

    return {
        "ok": False,
        "identifier": identifier,
        "normalized": normalized,
        "error": "모든 Sci-Hub 미러에서 PDF를 찾지 못했습니다.",
        "attempts": attempts,
        "mirrorsTried": mirrors,
    }


def safe_filename(stem: str) -> str:
    cleaned = re.sub(r"[^\w.\-]+", "_", stem, flags=re.UNICODE).strip("._")
    if not cleaned:
        cleaned = "paper"
    return cleaned[:180]


def default_pdf_name(resolution: dict[str, Any]) -> str:
    meta = resolution.get("metadata") or {}
    doi = meta.get("doi") or (resolution.get("normalized") or {}).get("doi")
    title = meta.get("title")
    if doi:
        return safe_filename(str(doi).replace("/", "_")) + ".pdf"
    if title:
        return safe_filename(str(title)) + ".pdf"
    query = (resolution.get("normalized") or {}).get("query") or "paper"
    return safe_filename(str(query)) + ".pdf"


def download_pdf(pdf_url: str, *, referer: str | None, destination: Path) -> dict[str, Any]:
    body, content_type, final_url = http_get(
        pdf_url,
        accept="application/pdf,*/*;q=0.8",
        referer=referer,
    )
    if not looks_like_pdf(body, content_type):
        raise RuntimeError(
            f"PDF가 아닌 응답을 받았습니다 (Content-Type={content_type!r}, url={final_url})."
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)
    return {
        "path": str(destination),
        "bytes": len(body),
        "contentType": content_type,
        "finalUrl": final_url,
    }


def tool_list_mirrors(_args: dict[str, Any]) -> dict[str, Any]:
    return text_result(
        {
            "ok": True,
            "mirrors": configured_mirrors(),
            "timeoutSeconds": HTTP_TIMEOUT_SECONDS,
            "maxPdfBytes": MAX_PDF_BYTES,
            "defaultOutputDir": DEFAULT_OUTPUT_DIR,
            "env": {
                "SCIHUB_MIRRORS": "comma-separated mirror bases",
                "SCIHUB_OUTPUT_DIR": "default download directory",
                "SCIHUB_HTTP_TIMEOUT": "request timeout seconds",
                "SCIHUB_MAX_PDF_BYTES": "max download size",
                "SCIHUB_USER_AGENT": "HTTP User-Agent override",
            },
            "notice": (
                "Sci-Hub 콘텐츠의 이용 가능 여부와 저작권 준수 책임은 호출자에게 있습니다. "
                "가능하면 공식 오픈액세스(Unpaywall/PMC 등)를 우선하세요."
            ),
        }
    )


def tool_resolve_paper(args: dict[str, Any]) -> dict[str, Any]:
    identifier = clean_identifier(args.get("identifier") or args.get("doi") or args.get("url"))
    resolution = resolve_against_mirrors(identifier)
    if not resolution.get("ok"):
        return text_result(resolution)
    return text_result(
        {
            "ok": True,
            "identifier": resolution["identifier"],
            "normalized": resolution["normalized"],
            "mirror": resolution["mirror"],
            "pageUrl": resolution["pageUrl"],
            "pdfUrl": resolution["pdfUrl"],
            "pdfCandidates": resolution.get("pdfCandidates") or [resolution["pdfUrl"]],
            "metadata": resolution.get("metadata") or {},
            "attempts": resolution.get("attempts") or [],
            "notice": (
                "PDF URL만 해석했습니다. 파일 저장은 fetch_paper를 사용하세요. "
                "저작권·접근 규정 준수는 호출자 책임입니다."
            ),
        }
    )


def tool_fetch_paper(args: dict[str, Any]) -> dict[str, Any]:
    identifier = clean_identifier(args.get("identifier") or args.get("doi") or args.get("url"))
    resolution = resolve_against_mirrors(identifier)
    if not resolution.get("ok"):
        return text_result(resolution)

    output_dir = Path(
        str(args["output_dir"]).strip() if args.get("output_dir") else DEFAULT_OUTPUT_DIR
    ).expanduser()
    if args.get("filename"):
        filename = safe_filename(str(args["filename"]))
        if not filename.lower().endswith(".pdf"):
            filename += ".pdf"
    else:
        filename = default_pdf_name(resolution)
    destination = output_dir / filename

    if destination.exists() and not bool(args.get("overwrite", False)):
        return text_result(
            {
                "ok": True,
                "cached": True,
                "path": str(destination),
                "bytes": destination.stat().st_size,
                "identifier": resolution["identifier"],
                "normalized": resolution["normalized"],
                "mirror": resolution["mirror"],
                "pageUrl": resolution["pageUrl"],
                "pdfUrl": resolution["pdfUrl"],
                "metadata": resolution.get("metadata") or {},
                "notice": "이미 파일이 있어 재다운로드하지 않았습니다. overwrite=true로 덮어쓸 수 있습니다.",
            }
        )

    saved = download_pdf(
        str(resolution["pdfUrl"]),
        referer=str(resolution.get("pageUrl") or resolution.get("mirror")),
        destination=destination,
    )
    return text_result(
        {
            "ok": True,
            "cached": False,
            "path": saved["path"],
            "bytes": saved["bytes"],
            "contentType": saved["contentType"],
            "finalUrl": saved["finalUrl"],
            "identifier": resolution["identifier"],
            "normalized": resolution["normalized"],
            "mirror": resolution["mirror"],
            "pageUrl": resolution["pageUrl"],
            "pdfUrl": resolution["pdfUrl"],
            "metadata": resolution.get("metadata") or {},
            "notice": (
                "PDF를 로컬에 저장했습니다. 저작권·접근 규정 준수는 호출자 책임입니다. "
                "텍스트 추출은 pdftools.pdftotext와 함께 사용할 수 있습니다."
            ),
        }
    )


TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_mirrors",
        "description": (
            "설정된 Sci-Hub 미러 목록과 환경 변수(SCIHUB_MIRRORS 등) 기본값을 반환한다. "
            "다운로드 전에 가용 미러를 확인할 때 사용한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "resolve_paper",
        "description": (
            "DOI, PMID, 출판사 URL 또는 식별자를 Sci-Hub 미러에서 해석해 PDF URL과 "
            "가능한 인용 메타데이터(title/authors/doi/journal/year)를 반환한다. "
            "파일은 저장하지 않는다. 오픈액세스 원천을 먼저 확인한 뒤 필요 시 사용한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {
                    "type": "string",
                    "description": "DOI(10.xxxx/...), PMID, 또는 논문/출판사 URL.",
                },
                "doi": {"type": "string", "description": "identifier 대신 쓸 DOI."},
                "url": {"type": "string", "description": "identifier 대신 쓸 URL."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "fetch_paper",
        "description": (
            "DOI/PMID/URL로 Sci-Hub에서 논문 PDF를 내려받아 로컬 경로에 저장한다. "
            "기본 저장 위치는 ~/Downloads/scihub (SCIHUB_OUTPUT_DIR로 변경 가능). "
            "저장된 경로를 반환하므로 이어서 pdftools로 텍스트 추출할 수 있다. "
            "저작권 준수 책임은 호출자에게 있다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {
                    "type": "string",
                    "description": "DOI, PMID, 또는 논문/출판사 URL.",
                },
                "doi": {"type": "string", "description": "identifier 대신 쓸 DOI."},
                "url": {"type": "string", "description": "identifier 대신 쓸 URL."},
                "output_dir": {
                    "type": "string",
                    "description": "PDF 저장 디렉터리. 생략 시 SCIHUB_OUTPUT_DIR 또는 ~/Downloads/scihub.",
                },
                "filename": {
                    "type": "string",
                    "description": "저장 파일명(.pdf 권장). 생략 시 DOI 또는 제목 기반.",
                },
                "overwrite": {
                    "type": "boolean",
                    "default": False,
                    "description": "true면 기존 파일을 덮어쓴다. 기본 false(캐시 재사용).",
                },
            },
            "additionalProperties": False,
        },
    },
]

TOOL_IMPL = {
    "list_mirrors": tool_list_mirrors,
    "resolve_paper": tool_resolve_paper,
    "fetch_paper": tool_fetch_paper,
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
        if not isinstance(arguments, dict):
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": error_result("arguments는 객체여야 합니다."),
            }
        try:
            result = impl(arguments)
        except Exception as exc:
            log(f"tool '{name}' 실패: {exc}")
            return {"jsonrpc": "2.0", "id": msg_id, "result": error_result(str(exc))}
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
        if not isinstance(msg, dict):
            continue
        try:
            response = handle_request(msg)
        except Exception as exc:
            log(f"디스패치 오류: {exc}")
            msg_id = msg.get("id")
            if msg_id is not None:
                emit({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(exc)}})
            continue
        if response is not None:
            emit(response)


if __name__ == "__main__":
    main()
