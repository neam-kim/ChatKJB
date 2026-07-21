# 스킬 정리(fix / merge) 계획 및 4-에이전트 공유

작성 근거: 실제 봇 사용 로그(runtime `state.sqlite`, 366 세션)와 4개 프로바이더의 스킬 저장소 인벤토리
분석 일자: 2026-07-12

---

## 1. 실제 사용 패턴 (근거 데이터)

runtime DB(`data/state.sqlite`) 기준 366 세션.

| 항목 | 분포 |
|------|------|
| 프로바이더 | codex 271 · claude 84 · agy 6 · grok 5 |
| 상위 프로젝트 | ChatKJB 113 · Normal work 28 · LLM Wiki 25 · 01_Finance 24 · Second Brain 23 · Experiment 17 · CRISPR 10 |

실사용 주제(세션 제목 표본): **KimJB.com 홈페이지 빌드/배포**, 재무 포트폴리오, **CRISPR PPT**, 메모리·제2의 뇌·장기기억, **LLM-Wiki compile**, Gmail 읽기.

즉 사용자는 codex를 주력으로 홈페이지·재무·CRISPR·메모리·위키 작업을 한다. 바이오 데이터베이스 조회 스킬(`*-skill` 50종)은 실세션에서 거의 호출되지 않으며 CRISPR만 실제로 쓰인다.

---

## 2. 스킬 저장소 현황 (4 에이전트)

| 프로바이더 | 스킬 루트 | 내용 |
|-----------|-----------|------|
| Claude | `~/.claude/skills` | 79개 — 커스텀 스킬 정본 + 바이오/재무 스킬 (마스터 컬렉션) |
| Codex | `~/.codex/skills`, `~/.codex/skills/.system`, `~/.codex/plugins/cache` | 번들 + 플러그인 스킬, 공유분은 `fablize`·`shared-skill-router` 심링크 |
| agy(Gemini) | `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/builtin/skills` | 네이티브 3 + 공유분 심링크 |
| **grok** | `~/.grok/skills` | 네이티브 8 (check-work, code-review, create-skill, docx, help, imagine, pptx, xlsx) |

공유 메커니즘: `src/resource-sync.ts`의 `syncSharedResources()`가 모든 skillRoot을 스캔해
`~/.claude/shared-resources/SKILLS.md` **단일 카탈로그**(절대경로 포함)를 생성하고,
`shared-skill-router` 스킬을 각 providerSkillRoot에 심링크한다. 각 에이전트는 라우터를 통해
카탈로그를 검색하고 필요한 `SKILL.md`를 절대경로로 읽는다.

---

## 3. FIX 목록

### F1. grok가 공유에서 완전히 배제됨 — ✅ 구현 완료
- **문제**: grok가 `skillRoots`·`providerSkillRoots` 어디에도 없어, (a) grok 네이티브 스킬 8종이
  공유 카탈로그에 등록되지 않고, (b) `shared-skill-router`가 grok에 설치되지 않아 grok는 공유
  카탈로그를 검색조차 못 함. 4개 중 1개가 고립.
- **조치**: `defaultPaths()`에 `~/.grok/skills`를 `skillRoots`와 `providerSkillRoots` 양쪽에 추가.
- **결과**: grok 네이티브 스킬 8종이 카탈로그에 등록되고, `~/.grok/skills/shared-skill-router`
  심링크 생성 확인. 이제 4 에이전트가 동일 카탈로그를 공유·소비한다.

### F2. 카탈로그 파서가 YAML 블록 스칼라(`description: >`)를 못 읽음 — ✅ 구현 완료
- **문제**: grok 스킬은 `description: >` (folded 블록 스칼라)로 여러 줄 설명을 쓰는데,
  `frontmatterValue()`가 단일 라인만 파싱해 카탈로그에 설명이 `>` 한 글자로만 남았다.
  → 다른 에이전트가 카탈로그만 보고는 grok 스킬 용도를 알 수 없음(공유 무력화).
- **조치**: `frontmatterValue()`가 `>`/`|` 블록 스칼라의 뒤따르는 들여쓰기 줄을 접어 한 줄
  설명으로 만들도록 수정. 재동기화 후 grok 스킬 설명이 카탈로그에 정상 표기됨을 확인.

### F3. 중복 물리 사본 — 조치 불필요(codex 관리 영역)
`skill-creator`, `skill-installer`, `plugin-creator`, `openai-docs`, `imagegen`이
`~/.claude/skills`와 `~/.codex/skills/.system`에 2벌 존재한다. 그러나 `.system`은 **codex가
관리하는 번들 영역**이라 임의 수정/심링크화는 codex 재생성 시 깨진다. 카탈로그는 우선순위
dedup으로 이미 단일 항목만 노출하므로(F2 파서 정상화 이후 설명도 정확) 실질 위험이 낮다. → 방치.

---

## 4. MERGE 목록 — 실행 전 성격 재확인으로 정정됨 ⚠️

**실행 직전 확인 결과, §4 초안의 전제가 틀렸다.** `~/.claude/skills`의 바이오 `*-skill` 50종은
손으로 만든 개별 스킬이 아니라 **설치된 Codex 플러그인 `life-science-research` 한 개**의
구성원 심링크였다(정본: `~/.codex/plugins/cache/openai-curated/life-science-research/.../skills/`).
`research-router-skill`도 그 플러그인의 내부 라우터다. 인접 플러그인 `ngs-analysis`(18 스킬)도 동일.

따라서 파일 단위 병합/삭제는 부적절하다:
- 플러그인 갱신·재설치 시 원복된다.
- `skillRoots`에 `~/.codex/plugins/cache`가 포함돼 있어, `.claude/skills` 심링크를 지워도
  캐시 루트 스캔으로 카탈로그에 그대로 남는다(현재 `life-science-research:*` 접두로 50개 등재).
- 플러그인 내부 정합성(자체 라우터가 구성원 참조)이 깨진다.

### 실제 조치 — "MCP와 중복된 것만 제거" (✅ 구현 완료)
어르신 결정: 플러그인 전체가 아니라 **이미 붙은 MCP 서버와 직접 겹치는 스킬만** 공유에서 제거.
플러그인 구성원이라 파일 삭제는 캐시 루트 재스캔으로 원복되므로, `buildSharedSkillCatalog`에
`MCP_REDUNDANT_SKILLS` denylist를 두어 **카탈로그 빌드 단계에서 제외**했다(정확·가역: 집합만
비우면 복구, 스킬 자체는 설치된 채 유지). 제외 18종과 대응 MCP:
`chembl-skill`(chembl), `biorxiv-skill`(biorxiv), `clinicaltrials-skill`(c-trials),
`opentargets-skill`(ot), `clinvar-variation-skill`·`gnomad-graphql-skill`·`gwas-catalog-skill`·
`ncbi-entrez-skill`(biomcp/pubmed), `ncbi-pmc-skill`(pubmed), 그리고
`reactome`·`string`·`uniprot`·`human-protein-atlas`·`alphafold`·`chebi`·`ensembl`·
`efo-ontology`·`pride`-skill(biocontext-kb). → 공유 카탈로그 204→186.
비중복 바이오 스킬(hmdb, pubchem-pug, rcsb-pdb, bindingdb 등)과 PheWAS/NCBI-datasets/eQTL은 유지.

- M1~M5(손 병합·플러그인 통째 언인스톨·라우터 일원화)는 **철회**한다. 위 denylist가 결정된
  목적("MCP 중복 제거")을 정확·가역적으로 달성한다. `ngs-analysis`(18) 플러그인은 CRISPR/NGS
  실작업용이라 유지.

### M6. 변형(variant) 계열 — 유지하되 관계 명시 (유효)
`patina`/`patina-max`, `insane-design`/`-apply`/`-build`,
`insane-research-main`/`-query`는 별개 동사라 병합보다 "패밀리"로 문서화가 적절.

---

## 5. 유지(keep) — 실사용 매핑되는 고가치 커스텀 스킬
`chatkjb-presentation-format`, `chatkjb-protocol-format`, `fablize`, `goaljaby`,
`show-me-the-prd`, `insane-design*`, `insane-research*`, `insane-search`, `patina*`,
`karpathy-guidelines`, `imagegen`, `skill-creator`, `skill-installer`, `plugin-creator`,
`docs-guide-knowledge`, `openai-docs`, `crispr-screen-analysis`,
재무(`dcf-model`, `lbo-model`, `comps-analysis`, `audit-xls`, `3-statement-model`, `clean-data-xls`).

---

## 6. 실제 변경된 것
- `src/resource-sync.ts`: grok skillRoot 편입(F1), 블록 스칼라 파서 수정(F2),
  MCP 중복 스킬 18종 카탈로그 제외 denylist(M-denylist).
- `tests/resource-sync.test.ts`: grok 카탈로그 편입·라우터 심링크·블록 스칼라 접힘·denylist 제외
  4개 테스트 추가(총 9 통과).
- `npm run shared:sync` 재실행: grok 라우터 심링크 생성, 공유 카탈로그 186 스킬(204에서 18 제외).

§4 MERGE 초안(손 병합)은 대상이 설치된 Codex 플러그인으로 판명돼 철회했고, 어르신 결정에 따라
MCP 중복 18종만 denylist로 제외했다. `ngs-analysis`(18)는 유지.
