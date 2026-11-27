import { describe, it, expect } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StreamReader, describeProgress, pruneRuns, runPaths, writeMeta } from "../src/runs.js";

const tempDir = () => mkdtempSync(path.join(tmpdir(), "agy-bridge-runs-"));

describe("StreamReader", () => {
  it("reads events as they're appended, holding back an unfinished line", async () => {
    const file = path.join(tempDir(), "run.jsonl");
    writeFileSync(file, '{"event":"init","conversation_id":"c-1"}\n{"event":"step_up');
    const reader = new StreamReader(file);
    expect(await reader.poll()).toMatchObject({ conversationId: "c-1", toolCalls: 0 });

    appendFileSync(
      file,
      'date","step_update":{"step_type":"tool","state":"DONE","tool_name":"grep_search",' +
        '"tool_info":{"parameters":{"Query":"QuotaError","SearchPath":"/repo"}}}}\n',
    );
    const state = await reader.poll();
    expect(describeProgress(state)).toBe("1 tool call so far, last: grep_search QuotaError");
  });

  it("keeps lines that aren't stream events, such as a CLI error", async () => {
    const file = path.join(tempDir(), "run.jsonl");
    writeFileSync(file, "Error: unknown flag --output-format\n");
    expect((await new StreamReader(file).poll()).otherOutput).toBe(
      "Error: unknown flag --output-format\n",
    );
  });
});

describe("pruneRuns", () => {
  it("removes runs started more than three days ago and keeps recent ones", async () => {
    const dir = tempDir();
    const now = Date.now();
    const base = { tool: "delegate", cwd: "/repo", timeoutSec: 600 };
    await writeMeta(dir, { ...base, runId: "old", startedAt: now - 4 * 24 * 3600 * 1000 });
    await writeMeta(dir, { ...base, runId: "new", startedAt: now - 3600 * 1000 });
    for (const id of ["old", "new"]) writeFileSync(runPaths(dir, id).out, "");

    await pruneRuns(dir, now);
    expect(existsSync(runPaths(dir, "old").meta)).toBe(false);
    expect(existsSync(runPaths(dir, "old").out)).toBe(false);
    expect(existsSync(runPaths(dir, "new").meta)).toBe(true);
    expect(existsSync(runPaths(dir, "new").out)).toBe(true);
  });
});
