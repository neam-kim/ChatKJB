import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMarkdown,
  buildMergedResultsMarkdown,
  chunkTurns,
  collectMergedResultEntries,
  collectResultFiles,
  fingerprintTurns,
  normalizeFingerprintText,
  parseResultEntries,
  scanExistingTranscriptSources,
} from "../scripts/dump-transcripts.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("transcript dump deduplication", () => {
  it("groups one user turn with its following assistant turns", () => {
    const chunks = chunkTurns([
      { role: "user", text: "질문 1" },
      { role: "assistant", text: "답변 1" },
      { role: "assistant", text: "보충 1" },
      { role: "user", text: "질문 2" },
      { role: "assistant", text: "답변 2" },
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ start: 1, end: 3 });
    expect(chunks[1]).toMatchObject({ start: 4, end: 5 });
  });

  it("makes whitespace and Unicode compatibility variants share a fingerprint", () => {
    const first = [{ role: "user" as const, text: "Ａ  B\r\n\r\n\r\nC" }];
    const second = [{ role: "user" as const, text: "A B\n\nC" }];

    expect(normalizeFingerprintText(first[0]!.text)).toBe("A B\n\nC");
    expect(fingerprintTurns(first)).toBe(fingerprintTurns(second));
  });

  it("writes stable source identity and chunk hashes into frontmatter", () => {
    const chunks = chunkTurns([
      { role: "user", text: "질문" },
      { role: "assistant", text: "답변" },
    ]);
    const markdown = buildMarkdown(
      {
        id: "session-123",
        provider: "claude",
        project_name: "LLM Wiki",
        title: "LLM Wiki - 중복 방지",
        model: "sonnet",
        codex_model: null,
        agy_model: null,
        created_at: Date.UTC(2026, 5, 21),
      },
      chunks,
      2
    );

    expect(markdown).toContain('source_key: "transcript:session-123"');
    expect(markdown).toContain("part: 2");
    expect(markdown).toContain("turn_start: 1");
    expect(markdown).toContain("turn_end: 2");
    expect(markdown).toContain("content_sha256:");
    expect(markdown).toContain("chunk_hashes_json:");
  });

  it("recovers emitted hashes and turn ranges from inbox and raw files", () => {
    const root = mkdtempSync(join(tmpdir(), "transcript-dump-"));
    temporaryDirectories.push(root);
    const inbox = join(root, "10-inbox");
    const raw = join(root, "20-raw");
    mkdirSync(inbox);
    mkdirSync(raw);
    writeFileSync(
      join(raw, "source.md"),
      [
        "---",
        "session_id: session-123",
        "part: 3",
        "turn_end: 8",
        `chunk_hashes_json: '${JSON.stringify(["hash-a", "hash-b"])}'`,
        "---",
        "",
      ].join("\n")
    );

    const recovered = scanExistingTranscriptSources([inbox, raw]);

    expect(recovered.sessions["session-123"]).toEqual({
      maxTurnEnd: 8,
      maxPart: 3,
    });
    expect(recovered.emittedChunkHashes).toEqual({
      "hash-a": "session-123",
      "hash-b": "session-123",
    });
  });
});

describe("global result file merge", () => {
  it("collects local and Synology roots without traversing a nested root twice", () => {
    const root = mkdtempSync(join(tmpdir(), "result-merge-"));
    temporaryDirectories.push(root);
    const localProject = join(root, "local-project");
    const synologyRoot = join(root, "Library", "CloudStorage", "SynologyDrive-neam");
    const synologyProject = join(synologyRoot, "AI", "wiki-project");
    mkdirSync(localProject, { recursive: true });
    mkdirSync(synologyProject, { recursive: true });
    writeFileSync(join(localProject, ".Result.md"), "- 로컬 결과\n");
    writeFileSync(join(synologyProject, ".result.md"), "- 시놀로지 결과\n");

    expect(collectResultFiles([root, synologyRoot])).toEqual([
      join(synologyProject, ".result.md"),
      join(localProject, ".Result.md"),
    ].sort());
  });

  it("uses the transcript fingerprint normalization to remove duplicate result entries", () => {
    const root = mkdtempSync(join(tmpdir(), "result-merge-"));
    temporaryDirectories.push(root);
    const localProject = join(root, "local-project");
    const synologyRoot = join(root, "SynologyDrive-neam");
    const synologyProject = join(synologyRoot, "AI", "wiki-project");
    mkdirSync(localProject, { recursive: true });
    mkdirSync(synologyProject, { recursive: true });
    const localFile = join(localProject, ".result.md");
    const synologyFile = join(synologyProject, ".result.md");
    writeFileSync(localFile, "- Ａ  결과\n- 로컬 고유 결과\n");
    writeFileSync(synologyFile, "- A 결과\n- 시놀로지 고유 결과\n");

    expect(parseResultEntries("- 첫째\n\n* 둘째\n")).toEqual(["첫째", "둘째"]);
    const merged = collectMergedResultEntries(
      [root, synologyRoot],
      [localFile, synologyFile]
    );
    expect(merged.hashes).toHaveLength(3);

    const markdown = buildMergedResultsMarkdown(
      merged,
      new Date("2026-06-21T00:00:00.000Z")
    );
    expect(markdown).toContain('source_key: "result-files:global"');
    expect(markdown).toContain("entries: 3");
    expect(markdown).toContain("Ａ  결과");
    expect(markdown).not.toContain("- A 결과");
    expect(markdown).toContain("로컬 고유 결과");
    expect(markdown).toContain("시놀로지 고유 결과");
  });
});
