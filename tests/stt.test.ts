import { describe, expect, it } from "vitest";
import { SttError, transcribeAudio, type SttConfig } from "../src/stt.js";

const baseConfig: SttConfig = {
  enabled: true,
  whisperCli: "whisper-cli",
  ffmpeg: "ffmpeg",
  modelPath: "/nonexistent/ggml-large-v3.bin",
  language: "auto",
  prompt: "",
  threads: 4,
  timeoutMs: 5_000
};

describe("transcribeAudio", () => {
  it("throws SttError when the model file is missing", async () => {
    await expect(
      transcribeAudio("/tmp/does-not-matter.ogg", baseConfig)
    ).rejects.toBeInstanceOf(SttError);
  });

  it("reports the missing model path in the error message", async () => {
    await expect(
      transcribeAudio("/tmp/does-not-matter.ogg", baseConfig)
    ).rejects.toThrow(/ggml-large-v3\.bin/);
  });
});
