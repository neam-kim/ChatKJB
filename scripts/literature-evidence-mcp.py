#!/usr/bin/env python3
"""Free, key-optional literature and clinical-trial search MCP server.

The server normalizes public Semantic Scholar and ClinicalTrials.gov responses
into the compact fields exposed by Elicit's search endpoints.  It intentionally
does not generate reports itself: ChatKJB can screen, extract, and synthesize the
returned evidence with the model already selected for the conversation.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "literature-evidence"
SERVER_VERSION = "1.0.0"

SEMANTIC_SCHOLAR_API_BASE = os.environ.get(
    "SEMANTIC_SCHOLAR_API_BASE",
    "https://api.semanticscholar.org/graph/v1",
).rstrip("/")
CLINICAL_TRIALS_API_BASE = os.environ.get(
    "CLINICAL_TRIALS_API_BASE",
    "https://clinicaltrials.gov/api/v2",
).rstrip("/")
OPENALEX_API_BASE = os.environ.get(
    "OPENALEX_API_BASE",
    "https://api.openalex.org",
).rstrip("/")
SEMANTIC_SCHOLAR_API_KEY = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "").strip()
OPENALEX_API_KEY = os.environ.get("OPENALEX_API_KEY", "").strip()

HTTP_TIMEOUT_SECONDS = 30
MAX_RESPONSE_BYTES = 12 * 1024 * 1024
MAX_QUERY_CHARS = 1000
MAX_RESULTS = 100

PAPER_FIELDS = ",".join(
    [
        "paperId",
        "title",
        "abstract",
        "authors",
        "year",
        "publicationDate",
        "venue",
        "externalIds",
        "citationCount",
        "referenceCount",
        "isOpenAccess",
        "openAccessPdf",
        "url",
        "publicationTypes",
    ]
)

PUBLICATION_TYPES = [
    "Review",
    "JournalArticle",
    "CaseReport",
    "ClinicalTrial",
    "Conference",
    "Dataset",
    "Editorial",
    "LettersAndComments",
    "MetaAnalysis",
    "News",
    "Study",
    "Book",
    "BookSection",
]


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(f"[literature-evidence-mcp] {message}", file=sys.stderr, flush=True)


def text_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [
            {"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}
        ]
    }


def error_result(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def clean_query(value: Any) -> str:
    query = str(value or "").strip()
    if not query:
        raise ValueError("query는 비어 있을 수 없습니다.")
    if len(query) > MAX_QUERY_CHARS:
        raise ValueError(f"query는 {MAX_QUERY_CHARS}자 이하여야 합니다.")
    return query


def bounded_limit(value: Any, default: int = 10) -> int:
    if value is None:
        return default
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit는 정수여야 합니다.") from exc
    if not 1 <= limit <= MAX_RESULTS:
        raise ValueError(f"limit는 1에서 {MAX_RESULTS} 사이여야 합니다.")
    return limit


def optional_year(value: Any, name: str) -> int | None:
    if value is None:
        return None
    try:
        year = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name}는 연도 정수여야 합니다.") from exc
    if not 1000 <= year <= date.today().year + 2:
        raise ValueError(f"{name}가 유효한 범위를 벗어났습니다.")
    return year


def fetch_json(
    base_url: str,
    path: str,
    params: list[tuple[str, str]],
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    query_string = urlencode(params)
    url = f"{base_url}{path}"
    if query_string:
        url += f"?{query_string}"
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "ChatKJB-literature-evidence/1.0",
        **(headers or {}),
    }
    request = Request(url, headers=request_headers, method="GET")
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        detail = exc.read(2048).decode("utf-8", errors="replace").strip()
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"외부 학술 API가 HTTP {exc.code}을 반환했습니다{suffix}") from exc
    except URLError as exc:
        raise RuntimeError(f"외부 학술 API에 연결할 수 없습니다: {exc.reason}") from exc

    if len(body) > MAX_RESPONSE_BYTES:
        raise RuntimeError("외부 학술 API 응답이 허용 크기를 초과했습니다.")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("외부 학술 API가 유효한 JSON을 반환하지 않았습니다.") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("외부 학술 API 응답의 최상위 형식이 객체가 아닙니다.")
    return payload


def normalized_paper(paper: dict[str, Any]) -> dict[str, Any]:
    external_ids = paper.get("externalIds")
    if not isinstance(external_ids, dict):
        external_ids = {}
    authors = paper.get("authors")
    author_names = [
        str(author.get("name"))
        for author in authors if isinstance(author, dict) and author.get("name")
    ] if isinstance(authors, list) else []

    urls: list[str] = []
    paper_url = paper.get("url")
    if isinstance(paper_url, str) and paper_url:
        urls.append(paper_url)
    open_pdf = paper.get("openAccessPdf")
    if isinstance(open_pdf, dict):
        pdf_url = open_pdf.get("url")
        if isinstance(pdf_url, str) and pdf_url and pdf_url not in urls:
            urls.append(pdf_url)

    return {
        "source": "semantic_scholar",
        "paperId": paper.get("paperId"),
        "title": paper.get("title") or "",
        "authors": author_names,
        "year": paper.get("year"),
        "publicationDate": paper.get("publicationDate"),
        "abstract": paper.get("abstract"),
        "doi": external_ids.get("DOI"),
        "pmid": external_ids.get("PubMed"),
        "venue": paper.get("venue"),
        "citedByCount": paper.get("citationCount"),
        "referenceCount": paper.get("referenceCount"),
        "publicationTypes": paper.get("publicationTypes") or [],
        "isOpenAccess": paper.get("isOpenAccess"),
        "openAccessPdf": open_pdf.get("url") if isinstance(open_pdf, dict) else None,
        "urls": urls,
    }


def reconstructed_abstract(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    positioned_words: list[tuple[int, str]] = []
    for word, positions in value.items():
        if not isinstance(word, str) or not isinstance(positions, list):
            continue
        for position in positions:
            if isinstance(position, int) and position >= 0:
                positioned_words.append((position, word))
    if not positioned_words:
        return None
    positioned_words.sort(key=lambda item: item[0])
    return " ".join(word for _, word in positioned_words)


def normalized_openalex_paper(work: dict[str, Any]) -> dict[str, Any]:
    authorships = work.get("authorships")
    author_names: list[str] = []
    if isinstance(authorships, list):
        for authorship in authorships:
            author = authorship.get("author") if isinstance(authorship, dict) else None
            if isinstance(author, dict) and author.get("display_name"):
                author_names.append(str(author["display_name"]))

    primary_location = work.get("primary_location")
    if not isinstance(primary_location, dict):
        primary_location = {}
    best_oa_location = work.get("best_oa_location")
    if not isinstance(best_oa_location, dict):
        best_oa_location = {}
    source = primary_location.get("source")
    if not isinstance(source, dict):
        source = {}
    open_access = work.get("open_access")
    if not isinstance(open_access, dict):
        open_access = {}
    ids = work.get("ids")
    if not isinstance(ids, dict):
        ids = {}

    pdf_url = best_oa_location.get("pdf_url") or primary_location.get("pdf_url")
    urls: list[str] = []
    for candidate in [
        primary_location.get("landing_page_url"),
        work.get("doi"),
        work.get("id"),
        pdf_url,
    ]:
        if isinstance(candidate, str) and candidate and candidate not in urls:
            urls.append(candidate)

    doi = work.get("doi")
    if isinstance(doi, str) and doi.lower().startswith("https://doi.org/"):
        doi = doi[len("https://doi.org/"):]
    pmid = ids.get("pmid")
    if isinstance(pmid, str):
        pmid = pmid.rstrip("/").rsplit("/", 1)[-1]

    work_type = work.get("type")
    return {
        "source": "openalex",
        "paperId": work.get("id"),
        "title": work.get("display_name") or work.get("title") or "",
        "authors": author_names,
        "year": work.get("publication_year"),
        "publicationDate": work.get("publication_date"),
        "abstract": reconstructed_abstract(work.get("abstract_inverted_index")),
        "doi": doi,
        "pmid": pmid,
        "venue": source.get("display_name"),
        "citedByCount": work.get("cited_by_count"),
        "referenceCount": len(work.get("referenced_works") or []),
        "publicationTypes": [work_type] if work_type else [],
        "isOpenAccess": open_access.get("is_oa"),
        "openAccessPdf": pdf_url,
        "urls": urls,
    }


def search_openalex_papers(
    query: str,
    limit: int,
    min_year: int | None,
    max_year: int | None,
    open_access_only: bool,
    min_citations: int | None,
) -> tuple[list[dict[str, Any]], Any]:
    params = [("search", query), ("per-page", str(limit))]
    filters: list[str] = []
    if min_year is not None:
        filters.append(f"from_publication_date:{min_year}-01-01")
    if max_year is not None:
        filters.append(f"to_publication_date:{max_year}-12-31")
    if open_access_only:
        filters.append("is_oa:true")
    if min_citations is not None and min_citations > 0:
        filters.append(f"cited_by_count:>{min_citations - 1}")
    if filters:
        params.append(("filter", ",".join(filters)))
    if OPENALEX_API_KEY:
        params.append(("api_key", OPENALEX_API_KEY))

    payload = fetch_json(OPENALEX_API_BASE, "/works", params)
    raw_works = payload.get("results")
    papers = [
        normalized_openalex_paper(work)
        for work in raw_works if isinstance(work, dict)
    ] if isinstance(raw_works, list) else []
    meta = payload.get("meta")
    total = meta.get("count") if isinstance(meta, dict) else None
    return papers, total


def tool_search_papers(args: dict[str, Any]) -> dict[str, Any]:
    query = clean_query(args.get("query"))
    limit = bounded_limit(args.get("limit"))
    min_year = optional_year(args.get("min_year"), "min_year")
    max_year = optional_year(args.get("max_year"), "max_year")
    if min_year is not None and max_year is not None and min_year > max_year:
        raise ValueError("min_year는 max_year보다 클 수 없습니다.")

    params = [("query", query), ("limit", str(limit)), ("fields", PAPER_FIELDS)]
    if min_year is not None or max_year is not None:
        params.append(("year", f"{min_year or ''}-{max_year or ''}"))
    if bool(args.get("open_access_only", False)):
        params.append(("openAccessPdf", ""))
    min_citations_value = args.get("min_citations")
    min_citations: int | None = None
    if min_citations_value is not None:
        try:
            min_citations = int(min_citations_value)
        except (TypeError, ValueError) as exc:
            raise ValueError("min_citations는 0 이상의 정수여야 합니다.") from exc
        if min_citations < 0:
            raise ValueError("min_citations는 0 이상의 정수여야 합니다.")
        params.append(("minCitationCount", str(min_citations)))

    requested_types = args.get("publication_types")
    if requested_types is not None:
        if not isinstance(requested_types, list) or not requested_types:
            raise ValueError("publication_types는 하나 이상의 문자열 배열이어야 합니다.")
        invalid = [item for item in requested_types if item not in PUBLICATION_TYPES]
        if invalid:
            raise ValueError(f"지원하지 않는 publication_types: {', '.join(map(str, invalid))}")
        params.append(("publicationTypes", ",".join(requested_types)))

    headers = {}
    if SEMANTIC_SCHOLAR_API_KEY:
        headers["x-api-key"] = SEMANTIC_SCHOLAR_API_KEY
    semantic_error: Exception | None = None
    try:
        payload = fetch_json(
            SEMANTIC_SCHOLAR_API_BASE,
            "/paper/search",
            params,
            headers,
        )
        raw_papers = payload.get("data")
        papers = [
            normalized_paper(paper)
            for paper in raw_papers if isinstance(paper, dict)
        ] if isinstance(raw_papers, list) else []
        source_name = "Semantic Scholar Academic Graph"
        total = payload.get("total")
        limitations = [
            "검색 순위는 Semantic Scholar의 relevance search이며 Elicit 벡터 검색과 같지 않습니다.",
            "초록과 메타데이터는 근거 탐색용입니다. 중요한 결론은 원문에서 확인해야 합니다.",
            "API 키 없이도 동작하지만 공유 비인증 쿼터 상황에 따라 OpenAlex로 폴백할 수 있습니다.",
        ]
    except Exception as exc:
        semantic_error = exc
        try:
            papers, total = search_openalex_papers(
                query,
                limit,
                min_year,
                max_year,
                bool(args.get("open_access_only", False)),
                min_citations,
            )
        except Exception as openalex_error:
            raise RuntimeError(
                "무료 논문 데이터 원천 두 곳에 모두 연결하지 못했습니다. "
                f"Semantic Scholar: {semantic_error}; OpenAlex: {openalex_error}"
            ) from openalex_error
        source_name = "OpenAlex (Semantic Scholar fallback)"
        limitations = [
            "Semantic Scholar가 제한되어 OpenAlex 검색 결과를 사용했습니다.",
            "OpenAlex 검색 순위는 Elicit 벡터 검색과 같지 않습니다.",
            "publication_types 필터는 OpenAlex 폴백에서 적용되지 않습니다.",
            "초록과 메타데이터는 근거 탐색용입니다. 중요한 결론은 원문에서 확인해야 합니다.",
            "OpenAlex는 무료 API 키와 일일 무료 사용량을 제공하며, 현재 무키 접근이 제한되면 OPENALEX_API_KEY가 필요합니다.",
        ]
    return text_result(
        {
            "ok": True,
            "source": source_name,
            "query": query,
            "totalEstimated": total,
            "count": len(papers),
            "papers": papers,
            "fallbackUsed": semantic_error is not None,
            "limitations": limitations,
        }
    )


def nested_dict(value: Any, *keys: str) -> dict[str, Any]:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def date_value(module: dict[str, Any], field: str) -> str | None:
    value = module.get(field)
    if isinstance(value, dict) and isinstance(value.get("date"), str):
        return value["date"]
    return None


def normalized_trial(study: dict[str, Any]) -> dict[str, Any]:
    protocol = nested_dict(study, "protocolSection")
    identification = nested_dict(protocol, "identificationModule")
    description = nested_dict(protocol, "descriptionModule")
    status = nested_dict(protocol, "statusModule")
    design = nested_dict(protocol, "designModule")
    conditions_module = nested_dict(protocol, "conditionsModule")
    interventions_module = nested_dict(protocol, "armsInterventionsModule")
    sponsors = nested_dict(protocol, "sponsorCollaboratorsModule")

    interventions = interventions_module.get("interventions")
    intervention_names = [
        str(item.get("name"))
        for item in interventions if isinstance(item, dict) and item.get("name")
    ] if isinstance(interventions, list) else []
    lead_sponsor = sponsors.get("leadSponsor")
    lead_sponsor_name = lead_sponsor.get("name") if isinstance(lead_sponsor, dict) else None
    enrollment = design.get("enrollmentInfo")
    enrollment_count = enrollment.get("count") if isinstance(enrollment, dict) else None
    last_updated = date_value(status, "studyFirstPostDateStruct")
    record_updated = date_value(status, "lastUpdatePostDateStruct")
    nct_id = identification.get("nctId") or ""

    return {
        "source": "clinicaltrials_gov",
        "nctId": nct_id,
        "title": identification.get("briefTitle") or identification.get("officialTitle") or "",
        "summary": description.get("briefSummary") or description.get("detailedDescription"),
        "url": f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else None,
        "overallStatus": status.get("overallStatus"),
        "phase": design.get("phases") or [],
        "studyType": design.get("studyType"),
        "enrollmentCount": enrollment_count,
        "conditions": conditions_module.get("conditions") or [],
        "interventions": intervention_names,
        "leadSponsor": lead_sponsor_name,
        "startDate": date_value(status, "startDateStruct"),
        "primaryCompletionDate": date_value(status, "primaryCompletionDateStruct"),
        "completionDate": date_value(status, "completionDateStruct"),
        "hasResults": study.get("hasResults"),
        "lastUpdatedYear": int(record_updated[:4]) if record_updated and record_updated[:4].isdigit() else None,
        "firstPostedDate": last_updated,
    }


def tool_search_clinical_trials(args: dict[str, Any]) -> dict[str, Any]:
    query = clean_query(args.get("query"))
    limit = bounded_limit(args.get("limit"))
    payload = fetch_json(
        CLINICAL_TRIALS_API_BASE,
        "/studies",
        [
            ("query.term", query),
            ("pageSize", str(limit)),
            ("countTotal", "true"),
            ("format", "json"),
        ],
    )
    raw_studies = payload.get("studies")
    trials = [
        normalized_trial(study)
        for study in raw_studies if isinstance(study, dict)
    ] if isinstance(raw_studies, list) else []
    return text_result(
        {
            "ok": True,
            "source": "ClinicalTrials.gov API v2",
            "query": query,
            "totalCount": payload.get("totalCount"),
            "count": len(trials),
            "nextPageToken": payload.get("nextPageToken"),
            "trials": trials,
            "limitations": [
                "검색은 ClinicalTrials.gov 등록 레코드 대상이며 Elicit 벡터 검색과 같지 않습니다.",
                "등록 정보와 게시 결과는 동료평가 논문을 대신하지 않습니다.",
            ],
        }
    )


TOOLS: list[dict[str, Any]] = [
    {
        "name": "search_papers",
        "description": (
            "Elicit 유료 Search/Reports/Systematic Review API의 무료 근거 검색 대안. "
            "Semantic Scholar에서 관련 논문을 검색하고 제목, 저자, 연도, 초록, DOI/PMID, "
            "학술지, 인용 수, 공개 PDF를 반환한다. 보고서 작성 전 근거 수집과 초록 선별에 사용한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "자연어 또는 핵심어 연구 질문."},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS, "default": 10},
                "min_year": {"type": "integer", "description": "최소 출판 연도."},
                "max_year": {"type": "integer", "description": "최대 출판 연도."},
                "open_access_only": {"type": "boolean", "default": False},
                "min_citations": {"type": "integer", "minimum": 0},
                "publication_types": {
                    "type": "array",
                    "items": {"type": "string", "enum": PUBLICATION_TYPES},
                    "description": "Semantic Scholar 논문 유형 필터.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_clinical_trials",
        "description": (
            "Elicit 유료 임상시험 검색의 무료 원천 대안. ClinicalTrials.gov에서 NCT ID, "
            "제목, 요약, 상태, 단계, 등록 수, 질환, 중재, 스폰서, 날짜와 결과 게시 여부를 반환한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "질환, 중재 또는 연구 질문."},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS, "default": 10},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]

TOOL_IMPL = {
    "search_papers": tool_search_papers,
    "search_clinical_trials": tool_search_clinical_trials,
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
