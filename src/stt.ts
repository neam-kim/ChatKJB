// 로컬 음성 받아쓰기(STT). 외부 API를 쓰지 않고 whisper.cpp(whisper-cli)와
// ffmpeg로만 처리해, Claude/Codex 사용량 한도나 외부 크레딧을 전혀 소모하지 않는다.
// 흐름: 임의 오디오(.ogg/.mp3/...) --ffmpeg--> 16kHz mono PCM wav --whisper-cli--> 텍스트.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SttConfig {
  /** 전사 기능 사용 여부. false면 handleFile은 기존처럼 파일 경로만 전달한다. */
  enabled: boolean;
  /** whisper-cli 실행 경로. */
  whisperCli: string;
  /** ffmpeg 실행 경로. */
  ffmpeg: string;
  /** ggml 모델 파일 경로(정확도 최우선: large-v3). */
  modelPath: string;
  /** 언어 코드. "auto"면 자동 감지, "ko"면 한국어 고정. */
  language: string;
  /**
   * 초기 프롬프트(용어 사전). 한∙영 혼용 시 영어 전문 용어의 철자·표기를 바로잡는다.
   * 빈 문자열이면 --prompt를 넘기지 않는다. whisper는 컨텍스트 절반(약 224토큰)까지만 반영한다.
   */
  prompt: string;
  /** whisper-cli 스레드 수. */
  threads: number;
  /** ffmpeg/whisper 각 단계 타임아웃(ms). */
  timeoutMs: number;
}

export class SttError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SttError";
  }
}

/**
 * 오디오 파일을 텍스트로 전사한다. 성공 시 공백 정리된 전사문을 반환한다.
 * 모델·실행기 부재나 변환 실패는 SttError로 던진다(호출부에서 완만히 강등).
 */
export async function transcribeAudio(inputPath: string, config: SttConfig): Promise<string> {
  if (!existsSync(config.modelPath)) {
    throw new SttError(`whisper 모델을 찾을 수 없습니다: ${config.modelPath}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "chatkjb-stt-"));
  const wavPath = join(workDir, "audio.wav");
  const outPrefix = join(workDir, "out");
  try {
    // 1) ffmpeg: 임의 오디오 → 16kHz mono PCM wav(whisper.cpp 요구 포맷).
    try {
      await execFileAsync(
        config.ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", inputPath,
          "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
          wavPath
        ],
        { timeout: config.timeoutMs }
      );
    } catch (error) {
      throw new SttError(`오디오 변환(ffmpeg) 실패: ${errText(error)}`, error);
    }

    // 2) whisper-cli: 전사 → <outPrefix>.txt.
    const whisperArgs = [
      "-m", config.modelPath,
      "-f", wavPath,
      "-l", config.language,
      "-t", String(config.threads),
      "-otxt", "-of", outPrefix,
      "-np", "-nt"
    ];
    if (config.prompt.trim()) whisperArgs.push("--prompt", config.prompt.trim());
    try {
      await execFileAsync(
        config.whisperCli,
        whisperArgs,
        { timeout: config.timeoutMs, maxBuffer: 32 * 1024 * 1024 }
      );
    } catch (error) {
      throw new SttError(`전사(whisper-cli) 실패: ${errText(error)}`, error);
    }

    let raw: string;
    try {
      raw = await readFile(`${outPrefix}.txt`, "utf8");
    } catch (error) {
      throw new SttError(`전사 결과 파일을 읽지 못했습니다: ${errText(error)}`, error);
    }

    // whisper.cpp는 무음/잡음 구간을 [BLANK_AUDIO] 등의 태그로 표기한다. 제거한다.
    const text = raw
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      throw new SttError("전사 결과가 비어 있습니다(무음이거나 인식 실패).");
    }
    return text;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function errText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown; }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim().slice(0, 500);
    return error.message;
  }
  return String(error);
}
