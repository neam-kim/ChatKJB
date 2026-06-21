#!/usr/bin/env python3
# agy-sdk-bridge.py
# Antigravity SDK를 stdio JSON-RPC 방식으로 감싸는 영속 브리지.
# TS 호스트(AgyInteractiveSession)와 1:1로 동작하며,
# turn 실행 중에도 cancel/close 메시지를 동시에 수신할 수 있도록
# stdin reader를 별도 asyncio Task로 분리한다.

import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
from google.antigravity import types
from google.antigravity import GeminiModelOptions, ThinkingLevel, GeminiAPIEndpoint, ModelTarget, ModelType
from google.antigravity.hooks import policy


def emit(payload: dict[str, Any]) -> None:
  sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
  sys.stdout.flush()


def load_mcp_servers(path: str) -> list[Any]:
  if not path:
    return []
  try:
    registry = json.loads(Path(path).read_text(encoding="utf-8"))
  except (OSError, json.JSONDecodeError):
    return []
  servers: list[Any] = []
  for name, config in registry.items():
    if not isinstance(config, dict):
      continue
    try:
      if config.get("type") == "stdio" and isinstance(config.get("command"), str):
        servers.append(types.McpStdioServer(
            name=name,
            command=config["command"],
            args=config.get("args") or [],
            env=config.get("env") or None,
        ))
      elif config.get("type") in ("http", "sse") and isinstance(config.get("url"), str):
        servers.append(types.McpStreamableHttpServer(
            name=name,
            url=config["url"],
            headers=config.get("headers") or None,
        ))
    except Exception:
      continue
  return servers


def capabilities(mode: str) -> tuple[CapabilitiesConfig, list[Any] | None]:
  """텔레그램 permissionMode → (CapabilitiesConfig, policies) 변환.

  모드별 매핑:
  - plan      : 읽기 전용 도구만 노출(쓰기 도구를 모델 문맥에서 완전히 제거).
                policies=None(SDK 기본 = confirm_run_command, 하지만 쓰기 도구가
                enabled_tools에 없으므로 실질적으로 무관).
  - default   : 전체 도구 노출, ASK_QUESTION은 비활성(텔레그램이 대신 승인),
                run_command는 SDK 기본 정책(confirm_run_command = 거부)이 적용됨.
  - acceptEdits: default와 동일하게 ASK_QUESTION 비활성,
                하지만 run_command를 포함해 모든 도구를 자동 허용(allow_all).
                "편집 수락"이라는 이름처럼 파일 수정·실행 모두 무승인.
  - dontAsk   : acceptEdits와 SDK 수준 표현이 동일.
                run_command를 포함해 묻지 않고 실행 — accept와의 구분은 UX 명칭.
  - auto      : dontAsk + 서브에이전트 허용(enable_subagents=True).

  ASK_QUESTION 비활성 이유: 텔레그램 오케스트레이터가 승인 브로커 역할을 하므로
  agy 내부 대화형 질문 흐름은 불필요하다. plan 모드는 쓰기 도구 자체가 없어
  disabled_tools를 별도로 지정할 필요가 없다.
  """
  readonly = [
      types.BuiltinTools.LIST_DIR,
      types.BuiltinTools.SEARCH_DIR,
      types.BuiltinTools.FIND_FILE,
      types.BuiltinTools.VIEW_FILE,
      types.BuiltinTools.SEARCH_WEB,
      types.BuiltinTools.FINISH,
  ]
  # plan: 읽기 전용 도구만 허용, policies 기본값 유지
  if mode == "plan":
    return CapabilitiesConfig(enabled_tools=readonly), None

  # auto: 서브에이전트 허용, 전 도구 무승인 실행
  if mode == "auto":
    caps = CapabilitiesConfig(
        enable_subagents=True,
        disabled_tools=[types.BuiltinTools.ASK_QUESTION],
    )
    return caps, [policy.allow_all()]

  # acceptEdits / dontAsk: 서브에이전트 없이 전 도구 무승인 실행
  # SDK 수준에서는 두 모드가 동일하게 표현됨(차이는 UX 명칭에만 있음).
  if mode in ("acceptEdits", "dontAsk"):
    caps = CapabilitiesConfig(disabled_tools=[types.BuiltinTools.ASK_QUESTION])
    return caps, [policy.allow_all()]

  # default(그 외 모든 값): ASK_QUESTION 비활성, run_command는 SDK 기본 정책(deny).
  caps = CapabilitiesConfig(disabled_tools=[types.BuiltinTools.ASK_QUESTION])
  return caps, None


def build_media_part(path: str, mime_type: str) -> types.Image | types.Document | types.Audio | types.Video | None:
  """파일 경로와 MIME 타입을 읽어 agy 네이티브 미디어 객체로 변환한다.

  MIME이 지원 집합에 없거나 파일을 읽을 수 없으면 None을 반환한다.
  None 반환 시 호출자는 이 첨부를 건너뛰고 텍스트 경로 폴백을 유지해야 한다.
  """
  if mime_type in types.SUPPORTED_IMAGE_MIMES:
    media_cls = types.Image
  elif mime_type in types.SUPPORTED_DOCUMENT_MIMES:
    media_cls = types.Document
  elif mime_type in types.SUPPORTED_AUDIO_MIMES:
    media_cls = types.Audio
  elif mime_type in types.SUPPORTED_VIDEO_MIMES:
    media_cls = types.Video
  else:
    # 지원되지 않는 MIME — 네이티브 첨부 건너뜀, 텍스트 경로 폴백 유지
    return None
  try:
    data = Path(path).read_bytes()
  except Exception as exc:
    print(f"[agy-bridge] 첨부 파일 읽기 실패, 건너뜀: {path!r} — {exc}", file=sys.stderr)
    return None
  return media_cls(data=data, mime_type=mime_type)


def retry_delay(error: Exception) -> float | None:
  text = str(error)
  if "RESOURCE_EXHAUSTED" not in text and "Error 429" not in text:
    return None
  match = re.search(r"(?:Please retry in|retryDelay[:=]?)\s*([0-9.]+)s", text, re.I)
  if not match:
    return 30.0
  return min(120.0, max(1.0, float(match.group(1)) + 1.0))


async def stdin_reader(queue: asyncio.Queue[dict[str, Any] | None]) -> None:
  """stdin을 전담하는 비동기 Task.
  줄이 끊기면 None을 큐에 넣어 메인 루프에 EOF를 알린다.
  이 Task가 별도로 돌기 때문에 turn 실행 중에도 cancel/close를 즉시 수신할 수 있다.
  """
  loop = asyncio.get_event_loop()
  while True:
    line = await loop.run_in_executor(None, sys.stdin.readline)
    if not line:
      # EOF
      await queue.put(None)
      return
    line = line.strip()
    if not line:
      continue
    try:
      msg = json.loads(line)
    except json.JSONDecodeError:
      continue
    await queue.put(msg)


async def run() -> None:
  # 메시지 큐: stdin_reader Task가 채우고, 메인 루프가 소비한다.
  queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
  reader_task = asyncio.create_task(stdin_reader(queue))

  # init 메시지를 큐에서 꺼낸다.
  init = await queue.get()
  if not init or init.get("type") != "init":
    reader_task.cancel()
    raise RuntimeError("Expected init message.")
  api_key = os.environ.get("GEMINI_API_KEY", "").strip()
  if not api_key:
    reader_task.cancel()
    raise RuntimeError("GEMINI_API_KEY is not configured.")

  model_str = init.get("model") or "gemini-3.1-pro-preview"
  thinking_str = (init.get("thinkingLevel") or "").strip().lower()

  # thinkingLevel이 주어졌을 때만 ModelTarget을 만들어 GeminiModelOptions에 실어 넘긴다.
  # null/없음이면 기존처럼 model=문자열로 LocalAgentConfig에 넘기고(API 기본 동작 보존),
  # ModelTarget을 만들지 않는다.
  _THINKING_LEVEL_MAP = {
      "minimal": ThinkingLevel.MINIMAL,
      "low": ThinkingLevel.LOW,
      "medium": ThinkingLevel.MEDIUM,
      "high": ThinkingLevel.HIGH,
  }
  if thinking_str and thinking_str in _THINKING_LEVEL_MAP:
    level = _THINKING_LEVEL_MAP[thinking_str]
    model_arg = ModelTarget(
        name=model_str,
        types=[ModelType.TEXT],
        endpoint=GeminiAPIEndpoint(
            api_key=api_key,
            options=GeminiModelOptions(thinking_level=level),
        ),
    )
  else:
    model_arg = model_str

  caps, mode_policies = capabilities(init.get("permissionMode") or "default")
  config = LocalAgentConfig(
      api_key=api_key,
      model=model_arg,
      system_instructions=init.get("systemInstructions") or None,
      capabilities=caps,
      policies=mode_policies,
      workspaces=[init["cwd"]],
      conversation_id=init.get("conversationId") or None,
      save_dir=str(Path.home() / ".local/share/telegram-claude-orchestrator/agy-conversations"),
      app_data_dir=str(Path.home() / ".local/share/telegram-claude-orchestrator/agy-app-data"),
      skills_paths=init.get("skillsPaths") or None,
      mcp_servers=load_mcp_servers(init.get("connectorRegistry") or ""),
  )

  async with Agent(config) as agent:
    emit({"type": "ready", "conversationId": agent.conversation_id})

    # active_turn_task: 현재 실행 중인 turn asyncio.Task (없으면 None)
    # active_response: 취소에 쓸 ChatResponse 핸들 (없으면 None)
    active_turn_task: asyncio.Task[None] | None = None
    active_response: types.ChatResponse | None = None

    def live_status_payload() -> dict[str, Any]:
      try:
        is_idle = getattr(agent.conversation, "is_idle", None)
      except Exception:
        is_idle = None
      try:
        turn_count = getattr(agent.conversation, "turn_count", None)
      except Exception:
        turn_count = None
      if isinstance(is_idle, bool):
        normalized_idle: bool | None = is_idle
      else:
        normalized_idle = None
      if isinstance(turn_count, bool):
        normalized_turn_count: int | None = None
      elif isinstance(turn_count, int):
        normalized_turn_count = turn_count
      else:
        normalized_turn_count = None
      return {
          "isIdle": normalized_idle,
          "turnCount": normalized_turn_count,
          "conversationId": agent.conversation_id,
      }

    async def handle_control_message(message: dict[str, Any]) -> None:
      control_id = str(message.get("id") or "")
      if not control_id:
        emit({"type": "control_error", "id": control_id, "message": "Missing control request id."})
        return
      try:
        if message.get("type") == "status":
          emit({"type": "status_result", "id": control_id, **live_status_payload()})
          return
        if message.get("type") == "clear_history":
          try:
            agent.conversation.clear_history()
          except AttributeError as exc:
            raise RuntimeError(f"clear_history is not supported: {exc}") from exc
          emit({"type": "clear_history_result", "id": control_id, "conversationId": agent.conversation_id})
          return
        raise RuntimeError(f"Unsupported control message: {message.get('type')}")
      except Exception as exc:
        emit({"type": "control_error", "id": control_id, "message": str(exc)})

    async def execute_turn(
        turn_id: str,
        prompt: str,
        attachments: list[dict[str, str]] | None = None,
    ) -> None:
      """단일 turn을 실행하는 코루틴. asyncio.Task로 띄운다.

      attachments는 [{path: str, mimeType: str}, ...] 목록이다.
      지원 MIME이면 네이티브 미디어 객체로 변환해 chat([prompt, media1, ...])로 전달한다.
      지원되지 않거나 파일 읽기에 실패한 첨부는 건너뛰고 텍스트 프롬프트의
      '저장 경로:' 줄이 모델 문맥에 남아 폴백 역할을 한다.
      """
      nonlocal active_response
      # 네이티브 미디어 객체 목록 구성 (agy 첨부 전용)
      media_parts: list[types.Image | types.Document | types.Audio | types.Video] = []
      if attachments:
        for att in attachments:
          part = build_media_part(att.get("path", ""), att.get("mimeType", ""))
          if part is not None:
            media_parts.append(part)
      # media_parts가 있으면 시퀀스 입력, 없으면 기존 문자열 입력 유지
      chat_input: str | list[object] = [prompt, *media_parts] if media_parts else prompt
      try:
        for attempt in range(3):
          chunks: list[str] = []
          try:
            active_response = await agent.chat(chat_input)
            async for token in active_response:
              chunks.append(token)
              emit({"type": "text_delta", "id": turn_id, "text": token})
            text = "".join(chunks)

            # 턴별 사용량과 대화 누적 사용량을 각각 직렬화한다.
            # 직렬화 실패는 정상 done emit을 막아서는 안 되므로 try/except로 감싼다.
            turn_usage = None
            total_usage = None
            try:
              um = active_response.usage_metadata
              if um is not None:
                turn_usage = um.model_dump()
            except Exception:
              pass
            try:
              total_usage = agent.conversation.total_usage.model_dump()
            except Exception:
              pass

            done_payload: dict[str, Any] = {
                "type": "done",
                "id": turn_id,
                "text": text,
                "conversationId": agent.conversation_id,
            }
            if turn_usage is not None:
              done_payload["usage"] = turn_usage
            if total_usage is not None:
              done_payload["totalUsage"] = total_usage
            emit(done_payload)
            break
          except asyncio.CancelledError:
            # asyncio.Task 취소(cancel() 호출로 인한 경우)
            raise
          except Exception as error:
            delay = retry_delay(error)
            if delay is None or attempt >= 2 or chunks:
              raise
            await asyncio.sleep(delay)
      except asyncio.CancelledError:
        # Task가 취소되었다 — ChatResponse.cancel()이 이미 호출된 상태이거나
        # Task 자체가 취소된 경우. turn aborted 이벤트를 emit 한다.
        emit({"type": "error", "id": turn_id, "message": "turn aborted"})
      except Exception as error:
        emit({"type": "error", "id": turn_id, "message": str(error)})
      finally:
        active_response = None

    while True:
      message = await queue.get()
      if message is None or message.get("type") == "close":
        # 정상 종료 — stdin EOF 또는 close 메시지
        break

      if message.get("type") == "cancel":
        # 현재 진행 중인 turn을 네이티브 취소한다.
        # 1단계: ChatResponse.cancel() 로 SDK 수준 취소 시도
        # 2단계: asyncio.Task.cancel() 로 코루틴 강제 중단
        if active_response is not None:
          try:
            await active_response.cancel()
          except Exception:
            pass
        if active_turn_task is not None and not active_turn_task.done():
          active_turn_task.cancel()
        # Task가 완전히 끝날 때까지 짧게 기다린다(emit 순서 보장).
        if active_turn_task is not None:
          try:
            await asyncio.wait_for(asyncio.shield(active_turn_task), timeout=3.0)
          except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        continue

      if message.get("type") in ("status", "clear_history"):
        await handle_control_message(message)
        continue

      if message.get("type") != "turn":
        continue

      # 이미 진행 중인 turn이 있으면 완료를 기다린다(직렬 실행 보장).
      if active_turn_task is not None and not active_turn_task.done():
        try:
          await active_turn_task
        except Exception:
          pass

      turn_id = str(message.get("id") or "")
      prompt = str(message.get("prompt") or "")
      # attachments: [{path, mimeType}, ...] — TS 측이 agy turn에만 포함한다.
      # 미포함이거나 빈 목록이면 기존 문자열 입력 경로를 유지한다.
      raw_att = message.get("attachments")
      attachments: list[dict[str, str]] | None = (
          raw_att if isinstance(raw_att, list) and raw_att else None
      )
      active_turn_task = asyncio.create_task(execute_turn(turn_id, prompt, attachments))

    # 루프 종료 — stdin reader Task도 정리한다.
    reader_task.cancel()
    try:
      await reader_task
    except asyncio.CancelledError:
      pass


if __name__ == "__main__":
  try:
    asyncio.run(run())
  except Exception as error:
    emit({"type": "fatal", "message": str(error)})
    raise
