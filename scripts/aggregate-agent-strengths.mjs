#!/usr/bin/env node
// LLM Wiki에 매일 쌓이는 트랜스크립트와 전역 작업 결과 로그를 읽어, 제공자(claude/codex/agy)별
// "강점 사전"을 집계해 _meta/agent-strengths.md 한 벌로 만든다. 이 문서는 멀티모델 조율자(라우터)의
// 입력이 되며, 파이프라인이 매일 데이터를 쌓을수록 이력 기반으로 정밀해진다.
//
// 안전 원칙(중요)
//   - 기존 위키(10-inbox/20-raw/30-wiki)와 dump-transcripts.mjs는 읽기 전용으로만 다룬다.
//   - 쓰는 곳은 위키화(/compile) 대상이 아닌 _meta/ 안의 단일 파일뿐이다.
//   - dump-transcripts.mjs가 이미 export한 파서를 재사용한다(중복 구현·새 의존성 없음).
//
// 입력
//   1) 트랜스크립트 .md (type: source, provider: ...) — 10-inbox, 20-raw
//        → provider별 사용 빈도·평균 turn·작업유형 분포·다룬 토픽
//   2) global-project-results.md — .result.md 병합본
//        → 항목별 성공/보류/실패 신호를 키워드로 근사하고 제공자 언급과 결합
//
// 출력
//   _meta/agent-strengths.md (frontmatter + 사람이 읽는 요약 + 라우터가 파싱할 표)
//
// 환경변수 오버라이드(기본값은 아래 상수):
//   WIKI_VAULT, STRENGTHS_OUT
//   DUMP_DRY_RUN=1 (파일 쓰지 않고 계획만 출력 — dump-transcripts.mjs와 같은 관례)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectMergedResultEntries,
  normalizeFingerprintText,
  parseResultEntries,
  readFrontmatter,
} from "./dump-transcripts.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const WIKI_VAULT =
  process.env.WIKI_VAULT ||
  "smb://JB_Kim._smb._tcp.local/homes/mac_neam96/AI/LLM-Wiki";
const INBOX_DIR = join(WIKI_VAULT, "10-inbox");
const RAW_DIR = join(WIKI_VAULT, "20-raw");
const RESULTS_FILE = join(INBOX_DIR, "global-project-results.md");
const OUT_FILE =
  process.env.STRENGTHS_OUT || join(WIKI_VAULT, "_meta", "agent-strengths.md");
const DRY_RUN = process.env.DUMP_DRY_RUN === "1";

const log = (...a) => console.log("[agent-strengths]", ...a);

const KNOWN_PROVIDERS = ["claude", "codex", "agy"];

// ── 작업유형 분류 ────────────────────────────────────────────────────────────
// 제목·요약·항목 텍스트의 키워드로 작업유형을 근사한다. 정밀 분류가 아니라 라우팅을
// 위한 거친 묶음이며, 데이터가 쌓이며 규칙을 보강하면 된다. 순서가 우선순위다.
const TASK_TYPE_RULES = [
  { type: "coding", keywords: ["구현", "리팩터", "리팩토링", "버그", "수정", "코드", "함수", "빌드", "테스트", "타입", "배포", "deploy", "refactor", "implement", "fix"] },
  { type: "multimodal", keywords: ["이미지", "사진", "아이콘", "pdf", "오디오", "비디오", "동영상", "음성", "ocr", "스크린샷", "그림"] },
  { type: "research", keywords: ["조사", "검토", "분석", "비교", "타당성", "리서치", "research", "조사하", "알아봐", "찾아"] },
  { type: "writing", keywords: ["요약", "번역", "작성", "문서", "정리", "위키", "노트", "글", "readme", "summary", "translate", "write"] },
  { type: "automation", keywords: ["자동", "스케줄", "cron", "launchd", "데몬", "파이프라인", "봇", "오케스트레이터", "automation", "schedule"] },
  { type: "integration", keywords: ["mcp", "커넥터", "연동", "통합", "api", "플러그인", "서버 등록", "integration", "connector"] },
];

function classifyTaskType(text) {
  const lower = String(text || "").toLowerCase();
  for (const rule of TASK_TYPE_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw.toLowerCase()))) return rule.type;
  }
  return "other";
}

// ── 성공/보류/실패 신호 휴리스틱 ─────────────────────────────────────────────
// .result.md 항목은 자연어이므로 정량 신호가 아니다. 키워드로 근사하며, 어느 쪽도
// 강하게 매칭되지 않으면 unknown으로 둔다(과대 해석 방지).
const SUCCESS_KEYWORDS = [
  "통과", "완료하였습니다", "완료했", "검증하였습니다", "확인하였습니다", "확인했",
  "정상", "성공", "해결하였습니다", "해결했", "반영하였습니다",
];
const HOLD_KEYWORDS = [
  "보류", "승인되지 않", "구현은 하지 않", "수행하지 않은", "아직", "제안하였으며", "제안하였습니다",
  "설명으로 마무리", "코드 변경은 하지 않",
];
const FAILURE_KEYWORDS = ["실패하였습니다", "실패했", "오류로", "되돌렸", "롤백", "포기"];

function classifyOutcome(text) {
  const t = String(text || "");
  // 실패가 가장 강한 신호 → 보류 → 성공 순으로 판정(부정 표현이 성공 키워드를 덮도록).
  if (FAILURE_KEYWORDS.some((kw) => t.includes(kw))) return "failure";
  if (HOLD_KEYWORDS.some((kw) => t.includes(kw))) return "hold";
  if (SUCCESS_KEYWORDS.some((kw) => t.includes(kw))) return "success";
  return "unknown";
}

// 항목 텍스트에서 명시적으로 언급된 제공자를 모은다(여러 개일 수 있음).
function providersMentioned(text) {
  const lower = String(text || "").toLowerCase();
  const found = [];
  if (lower.includes("claude") || lower.includes("클로드")) found.push("claude");
  if (lower.includes("codex") || lower.includes("코덱스")) found.push("codex");
  if (lower.includes("agy") || lower.includes("gemini") || lower.includes("제미나이") || lower.includes("antigravity")) {
    found.push("agy");
  }
  return found;
}

// ── 트랜스크립트 frontmatter 수집 ────────────────────────────────────────────
function collectTranscripts(directories = [INBOX_DIR, RAW_DIR]) {
  const records = [];
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const fm = readFrontmatter(join(dir, entry.name));
      // provider가 박힌 트랜스크립트 source만 — 병합 결과 로그·README 등은 제외.
      if (!fm || fm.type !== "source" || !fm.provider) continue;
      if (!KNOWN_PROVIDERS.includes(fm.provider)) continue;
      const turns = Number(fm.turns || fm.turn_end || 0);
      const subject = `${fm.title || ""} ${fm.summary || ""} ${fm.topic || ""}`;
      records.push({
        provider: fm.provider,
        model: fm.model || "",
        topic: fm.topic || "",
        turns: Number.isFinite(turns) ? turns : 0,
        taskType: classifyTaskType(subject),
        date: fm.session_date || fm.ingested || "",
      });
    }
  }
  return records;
}

// ── 집계 ─────────────────────────────────────────────────────────────────────
function emptyStat() {
  return {
    sessions: 0,
    totalTurns: 0,
    taskTypes: {},
    topics: {},
    models: {},
    outcomes: { success: 0, hold: 0, failure: 0, unknown: 0 },
    resultMentions: 0,
  };
}

function aggregate(transcripts, resultEntries) {
  const byProvider = {};
  for (const p of KNOWN_PROVIDERS) byProvider[p] = emptyStat();

  for (const r of transcripts) {
    const stat = byProvider[r.provider];
    stat.sessions += 1;
    stat.totalTurns += r.turns;
    stat.taskTypes[r.taskType] = (stat.taskTypes[r.taskType] || 0) + 1;
    if (r.topic) stat.topics[r.topic] = (stat.topics[r.topic] || 0) + 1;
    if (r.model) stat.models[r.model] = (stat.models[r.model] || 0) + 1;
  }

  // 결과 로그: 제공자가 명시적으로 언급된 항목만 그 제공자의 성과 신호로 센다.
  // 한 항목이 여러 제공자를 언급하면 각자에게 같은 결과를 귀속한다(공동 작업으로 간주).
  for (const entry of resultEntries) {
    const providers = providersMentioned(entry);
    if (!providers.length) continue;
    const outcome = classifyOutcome(entry);
    for (const p of providers) {
      const stat = byProvider[p];
      stat.resultMentions += 1;
      stat.outcomes[outcome] += 1;
    }
  }

  return byProvider;
}

// ── Markdown 생성 ────────────────────────────────────────────────────────────
function topEntries(map, limit) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function avgTurns(stat) {
  return stat.sessions > 0 ? (stat.totalTurns / stat.sessions).toFixed(1) : "0.0";
}

function successRate(stat) {
  const scored = stat.outcomes.success + stat.outcomes.hold + stat.outcomes.failure;
  if (scored === 0) return "—";
  return `${Math.round((stat.outcomes.success / scored) * 100)}%`;
}

function buildMarkdown(byProvider, meta) {
  const generatedDate = meta.generatedAt.toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    "type: meta",
    'title: "Agent strengths dictionary"',
    'summary: "LLM Wiki 트랜스크립트와 전역 작업 결과 로그에서 집계한 제공자별 강점 사전. 멀티모델 조율자(라우터)의 입력이며 위키화 대상이 아니다."',
    `generated: ${generatedDate}`,
    "provenance: aggregated",
    "source_key: \"agent-strengths:meta\"",
    `transcripts_scanned: ${meta.transcriptCount}`,
    `result_entries_scanned: ${meta.resultEntryCount}`,
    "---",
    "",
  ].join("\n");

  const lines = [];
  lines.push("# Agent strengths dictionary");
  lines.push("");
  lines.push(
    `생성일 ${generatedDate}. 트랜스크립트 ${meta.transcriptCount}건, 결과 항목 ${meta.resultEntryCount}건을 집계했습니다. ` +
      "이 문서는 자동 생성되며 멀티모델 조율자의 입력으로 쓰입니다."
  );
  lines.push("");
  lines.push(
    "> 한계: 작업유형과 성공/보류/실패는 자연어 키워드 휴리스틱으로 근사한 값입니다. " +
      "데이터가 쌓일수록 정밀해지며, 단일 신뢰 근거가 아니라 라우팅의 한 입력으로만 사용해야 합니다."
  );
  lines.push("");

  // 라우터가 파싱하기 쉬운 요약 표.
  lines.push("## 요약 (provider × 핵심 지표)");
  lines.push("");
  lines.push("| Provider | 세션 | 평균 turn | 주력 작업유형 | 성공신호율 | 결과 언급 |");
  lines.push("|---|---:|---:|---|---:|---:|");
  for (const p of KNOWN_PROVIDERS) {
    const stat = byProvider[p];
    const topType = topEntries(stat.taskTypes, 1)[0];
    const topTypeLabel = topType ? `${topType[0]} (${topType[1]})` : "—";
    lines.push(
      `| ${p} | ${stat.sessions} | ${avgTurns(stat)} | ${topTypeLabel} | ${successRate(stat)} | ${stat.resultMentions} |`
    );
  }
  lines.push("");

  // provider별 상세.
  for (const p of KNOWN_PROVIDERS) {
    const stat = byProvider[p];
    lines.push(`## ${p}`);
    lines.push("");
    if (stat.sessions === 0 && stat.resultMentions === 0) {
      lines.push("아직 집계된 데이터가 없습니다.");
      lines.push("");
      continue;
    }
    lines.push(`- 세션 ${stat.sessions}건, 누적 ${stat.totalTurns} turn, 평균 ${avgTurns(stat)} turn/세션.`);
    const types = topEntries(stat.taskTypes, 6);
    if (types.length) {
      lines.push(`- 작업유형 분포: ${types.map(([t, n]) => `${t} ${n}`).join(", ")}.`);
    }
    const topics = topEntries(stat.topics, 5);
    if (topics.length) {
      lines.push(`- 다룬 토픽: ${topics.map(([t, n]) => `${t}(${n})`).join(", ")}.`);
    }
    const models = topEntries(stat.models, 4);
    if (models.length) {
      lines.push(`- 사용 모델: ${models.map(([m, n]) => `${m}(${n})`).join(", ")}.`);
    }
    const o = stat.outcomes;
    lines.push(
      `- 결과 신호(언급 ${stat.resultMentions}건): 성공 ${o.success}, 보류 ${o.hold}, 실패 ${o.failure}, 불명 ${o.unknown}.`
    );
    lines.push("");
  }

  lines.push("## 라우팅 힌트 (자동 도출)");
  lines.push("");
  const hints = deriveHints(byProvider);
  if (hints.length) {
    for (const h of hints) lines.push(`- ${h}`);
  } else {
    lines.push("- 데이터가 더 쌓이면 작업유형별 권장 제공자를 도출합니다.");
  }
  lines.push("");

  return frontmatter + lines.join("\n") + "\n";
}

// 작업유형별로 세션 수가 가장 많은 제공자를 "관측상 주 담당"으로 도출한다. 학습이 아니라
// 단순 빈도 기반이며, 라우터가 규칙표의 출발점으로 삼을 수 있는 거친 힌트다.
function deriveHints(byProvider) {
  const typeToProvider = {};
  for (const p of KNOWN_PROVIDERS) {
    for (const [type, count] of Object.entries(byProvider[p].taskTypes)) {
      if (type === "other") continue;
      const best = typeToProvider[type];
      if (!best || count > best.count) typeToProvider[type] = { provider: p, count };
    }
  }
  return Object.entries(typeToProvider)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, { provider, count }]) => `작업유형 \`${type}\` → 관측상 ${provider}가 가장 많이 담당 (${count}건).`);
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const transcripts = collectTranscripts();

  let resultEntries = [];
  if (existsSync(RESULTS_FILE)) {
    // 병합 결과 로그는 "- 항목" 라인들의 집합이다. parseResultEntries로 라인을 항목으로
    // 끊고, frontmatter/헤더 노이즈를 정규화 후 제거한다.
    const text = readFileSync(RESULTS_FILE, "utf8");
    const body = text.startsWith("---\n")
      ? text.slice(text.indexOf("\n---", 4) + 4)
      : text;
    resultEntries = parseResultEntries(body)
      .map((e) => normalizeFingerprintText(e))
      .filter((e) => e && !e.startsWith("#") && !e.startsWith("Source:"));
  } else {
    log("결과 로그 없음:", RESULTS_FILE);
  }

  const byProvider = aggregate(transcripts, resultEntries);
  const markdown = buildMarkdown(byProvider, {
    generatedAt: new Date(),
    transcriptCount: transcripts.length,
    resultEntryCount: resultEntries.length,
  });

  if (DRY_RUN) {
    log(
      `would write ${OUT_FILE} (transcripts=${transcripts.length}, result-entries=${resultEntries.length})`
    );
    for (const p of KNOWN_PROVIDERS) {
      const s = byProvider[p];
      log(`  ${p}: sessions=${s.sessions} avgTurns=${avgTurns(s)} mentions=${s.resultMentions} success=${successRate(s)}`);
    }
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, markdown, "utf8");
  log(
    `done — transcripts=${transcripts.length} result-entries=${resultEntries.length} dest=${OUT_FILE}`
  );
}

export {
  aggregate,
  buildMarkdown,
  classifyOutcome,
  classifyTaskType,
  collectTranscripts,
  deriveHints,
  main as runAggregation,
  providersMentioned,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
