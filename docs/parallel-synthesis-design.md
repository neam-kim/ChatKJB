# 2단계 병렬 종합 설계안 (ChatKJB 멀티모델 조율)

상태: **설계 검토용 초안 (2026-06-22).** 코드 미작성. 어르신 검토·승인 후 구현.

연관 문서: 1단계 라우터 `src/router.ts`, 강점 사전 `LLM-Wiki/_meta/agent-strengths.md`,
전역 메모리 `project_chatkjb_multimodel_orchestration`.

---

## 1. 목표와 비목표

**목표**: 같은 작업을 Claude·Codex·agy 중 둘 이상에게 동시에 시키고, 로컬 qwen3.6 심사자가
가장 나은 답을 고른 뒤, 종합자가 최종 답 하나를 만든다. *틀리면 비싼* 중요 작업의 품질을 올린다.

**비목표 (의도적으로 안 하는 것)**:
- 모든 작업에 적용하지 않는다. 토큰·시간이 N배이므로 **명시적으로 켤 때만** 동작한다.
- 로컬 qwen3는 **심사 전용**이다. 작업 수행·종합에는 절대 쓰지 않는다(과거 철폐 사유 존중).
- 학습·자동 튜닝 없다. 결정적 규칙 + 1단계 강점 사전 힌트만 쓴다.

## 2. 실측 전제 (2026-06-22 확인됨)

- Ollama 서버 `localhost:11434` 백그라운드 가동.
- 모델 `qwen3.6:27b-96k` (27.8B Q4_K_M, base ctx 262144, `num_ctx 98304` 고정, capabilities=tools/thinking/vision).
- 라이브 심사 성공: system(중립 심사자, JSON만)+user(후보들), `think:false`,`temperature:0`,
  `num_ctx:8192` → `{"winner":1,"reason":...}` 정확 반환. eval ~2.3s (+최초 load ~8.8s).

## 3. 흐름 (한 번의 병렬 종합 턴)

```
사용자 작업
   │
   ├─(1) 후보 선정: 라우터가 작업유형 분류 → 강점 사전 상위 N개 provider 선택 (기본 2~3)
   │
   ├─(2) 병렬 실행: 선택된 provider들에게 같은 프롬프트를 동시 실행
   │        executeClaude / executeCodex / executeAgy 를 Promise.allSettled 로 묶음
   │        각자 독립 AbortController·세션. 하나 실패해도 나머지로 진행.
   │
   ├─(3) 심사: 로컬 qwen3.6 에 후보 답들을 주고 {winner, reason} 받기
   │        실패/타임아웃/서버다운 → Haiku 심사로 자동 강등 (폴백)
   │        후보가 1개만 성공 → 심사 생략, 그 답이 승자
   │
   ├─(4) 종합: 승자 provider(또는 고정 Claude)에게
   │        "네 답을 기준으로, 다른 후보의 더 나은 부분을 통합해 최종본을 내라" 1회 호출
   │        (단순 모드: 종합 생략하고 승자 답 그대로 — 비용 절감 옵션)
   │
   └─(5) 반환: 최종답 + 심사 근거 + 어느 provider들이 후보였는지 (투명성)
```

## 4. 구성요소별 설계

### 4.1 트리거 (언제 켜지나)
- 명시적: `/synth <작업>` 또는 세션 플래그 `synthMode`. 기본 OFF.
- 후보 수: 기본 2 (강점 사전 상위 2 provider). `/synth3` 등으로 3 지정 가능.
- 가드: 한 provider만 가용하면 병렬 의미 없음 → 단일 실행으로 자동 강등 + 안내.

### 4.2 병렬 실행 계층 (신규, session-manager 내)
- 기존 `execute`/`executeCodex`/`executeAgy`는 **사용자 세션 1개에 묶여** 렌더러·active 맵·
  토픽에 결과를 흘린다. 병렬용으로는 **결과를 텍스트로 수집만 하는 경량 실행 헬퍼**가 필요하다.
  → 옵션 A: 각 provider별 "조용한 1회 실행"(스트리밍을 토픽에 안 흘리고 최종 텍스트만 반환)
    헬퍼를 추가. 기존 메서드 재사용보다 부수효과 격리가 쉬움.
  → 옵션 B: 임시 하위 세션 3개를 만들어 실행 후 파기. 상태 오염 위험·복잡 → 비권장.
- **권장 A.** `runSilentTurn(provider, prompt, signal): Promise<{text, error}>` 형태.
- `Promise.allSettled`로 동시 대기. 전체 타임아웃(예: 작업당 상한) + 개별 AbortController.

### 4.3 심사자 (로컬 qwen3.6 + Haiku 폴백) — 신규 모듈 `src/judge.ts`
- 순수하게 테스트 가능한 형태로 분리.
- `judgeLocal(question, candidates): Promise<{winner, reason} | null>`
    - POST `http://localhost:11434/api/chat`, model=`qwen3.6:27b-96k`,
      `stream:false`,`think:false`,`options:{temperature:0,num_ctx:<후보크기에 맞춤>}`.
    - system: "중립 심사자. 작업 수행 금지, 후보 비교만. JSON 한 줄만."
    - 타임아웃(예: 60s) + JSON 파싱 실패 시 null.
- `judgeHaiku(question, candidates)` — 기존 `/goal` 평가자와 같은 GOAL_EVAL_MODEL 패턴 재사용.
- `judge(...)` = `judgeLocal` 시도 → null이면 `judgeHaiku` 폴백. 어느 쪽을 썼는지 메타 반환.
- 환경 오버라이드: `JUDGE_OLLAMA_URL`, `JUDGE_MODEL`, `JUDGE_DISABLE_LOCAL=1`(폴백 강제).

### 4.4 종합자
- 기본: 승자 provider에게 통합 프롬프트 1회. 기존 실행 경로 재사용.
- 단순 모드(`synthMode=pick`): 종합 생략, 승자 답 그대로 반환(심사만, 비용 최소).
- 통합 프롬프트는 `summarizeForHandoff`의 인계 요약 패턴을 본떠 일관성 유지.

### 4.5 투명성 (사용자에게 보이는 것)
- 최종답 + 짧은 꼬리말: "후보: Claude·Codex / 심사: 로컬qwen3(또는 Haiku 폴백) / 선택: Codex / 근거: …"
- 어르신 시스템의 공개 진행 설명 규약과 일치.

## 5. 실패·강등 매트릭스 (단일 장애점 제거)

| 상황 | 동작 |
|---|---|
| 후보 provider 1개 실패 | 나머지로 심사 진행 |
| 후보 전부 실패 | 오류 보고, 종합 없음 |
| 후보 1개만 성공 | 심사 생략, 그 답이 최종 |
| 로컬 qwen3 다운/타임아웃/JSON깨짐 | Haiku 심사로 자동 강등 |
| Haiku마저 실패 | 강점 사전 1순위 provider 답을 기본 선택 + 경고 |
| Ollama 미설치/포트 닫힘 | judgeLocal 즉시 null → 폴백 (사전 ping 1회로 빠른 판단) |

## 6. 비용·성능 메모
- 토큰: 후보 N개 실행 + 종합 1회. 로컬 심사는 토큰 비용 0(전기·시간만).
- 시간: 병렬이므로 후보 중 최장 1개 + 심사 수 초 + 종합 1회.
- 그래서 **중요 작업 한정**. 일상 작업은 1단계 라우터(단일 provider)로 충분.

## 7. 구현 단위 (승인 시 순서)
1. `src/judge.ts` + 테스트 (로컬 호출 mock, 폴백 분기, JSON 파싱).
2. `runSilentTurn` 병렬 실행 헬퍼 + 테스트.
3. 종합 오케스트레이션(트리거·강등 매트릭스) + 테스트.
4. `/synth` 봇 명령 + 투명성 꼬리말.
5. 타입검사·전체테스트·라이브 1회.

## 8. 확정 결정 (2026-06-22)
- (a) 종합 기본값 = **승자 기반 통합(synth)**. 승자 답을 기준으로 다른 후보의 더 나은 부분을 합쳐 최종본 생성.
- (b) 후보 개수 = **3개 전부**(Claude·Codex·agy). 가용한 것만, 미가용은 자동 제외.
- (c) 트리거 = **명시 `/synth` 명령만**. 기본 OFF. 자동 트리거 없음.
- (d) **후보 실행 = 읽기·조언 전용.** 3 provider를 읽기 전용(plan/read-only sandbox)으로 병렬 실행 →
  같은 워킹트리를 동시에 수정할 위험 없음. 코드 수정형 작업은 /synth 대상 아님(파일 충돌 방지).
  종합도 텍스트 답변. worktree 격리 불필요. 수정 포함 병렬은 격리 설계 검증 후 별도 트랙.
