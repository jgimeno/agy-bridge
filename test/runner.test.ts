import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgyRunError,
  buildArgs,
  collectRun,
  stdinMessage,
  truncate,
  runAgy,
  execWithClosedStdin,
  treeKill,
  type ChildHandle,
  type RunnerDeps,
  type RunRequest,
  type SpawnOptions,
  type TreeKillExecFn,
} from "../src/runner.js";
import { runPaths, writeMeta } from "../src/runs.js";
import { QuotaError } from "../src/quota.js";
import type { Config } from "../src/config.js";

let cfg: Config;

beforeEach(() => {
  cfg = {
    agyPath: "agy",
    timeoutSec: 600,
    timeoutExplicit: false,
    perToolTimeouts: {},
    maxOutputChars: 100,
    defaultModel: undefined,
    skipPermissions: true,
    sandbox: false,
    onFailure: "fallback",
    waitSec: 5,
    runsDir: mkdtempSync(path.join(tmpdir(), "agy-bridge-runs-")),
  };
});

const LOG_429 =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";

const init = (id = "conv-1") => JSON.stringify({ event: "init", conversation_id: id, init: {} });
const toolStep = (name: string, parameters: Record<string, unknown>) =>
  JSON.stringify({
    event: "step_update",
    step_update: { step_type: "tool", state: "DONE", tool_name: name, tool_info: { parameters } },
  });
const result = (fields: Record<string, unknown>) =>
  JSON.stringify({
    event: "result",
    result: { conversation_id: "conv-1", status: "SUCCESS", response: "", ...fields },
  });

interface FakeOpts {
  /** Stream lines agy writes as soon as it starts. */
  lines?: string[];
  /** Stream lines written later, after which agy exits. */
  later?: { lines: string[]; afterMs: number };
  stderr?: string;
  log?: string;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  neverExit?: boolean;
}

/** A fake agy that writes its stream, stderr and log to the run's files, like the real one. */
function fakeDeps(opts: FakeOpts = {}) {
  const kills: string[] = [];
  let capturedArgs: string[] | undefined;
  let capturedOpts: SpawnOptions | undefined;

  const deps: RunnerDeps = {
    spawnChild: (_file, args, spawnOpts) => {
      capturedArgs = args;
      capturedOpts = spawnOpts;
      let resolveExit!: (v: { code: number | null; error?: NodeJS.ErrnoException }) => void;
      const exit = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>(
        (r) => (resolveExit = r),
      );
      if (opts.spawnError) {
        setTimeout(() => resolveExit({ code: null, error: opts.spawnError }), 0);
        return { pid: undefined, wait: () => exit, kill: () => {} };
      }
      const write = (lines: string[]) =>
        appendFileSync(spawnOpts.outPath, lines.map((l) => `${l}\n`).join(""));
      if (opts.log) writeFileSync(args[args.indexOf("--log-file") + 1], opts.log);
      if (opts.stderr) writeFileSync(spawnOpts.errPath, opts.stderr);
      write(opts.lines ?? []);
      const end = () => {
        if (!opts.neverExit) resolveExit({ code: opts.exitCode ?? 0 });
      };
      setTimeout(() => {
        if (opts.later) write(opts.later.lines);
        end();
      }, opts.later?.afterMs ?? 0);
      const child: ChildHandle = {
        pid: 4242,
        wait: () => exit,
        kill: (sig) => {
          kills.push(sig);
        },
      };
      return child;
    },
    isAlive: () => false,
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return { deps, kills, args: () => capturedArgs, spawnOpts: () => capturedOpts };
}

const req = (fields: Partial<RunRequest> = {}): RunRequest => ({
  tool: "delegate",
  prompt: "q",
  cwd: "/repo",
  waitSec: 5,
  ...fields,
});

describe("buildArgs", () => {
  it("builds full arg list with log file, stream output and per-request timeout", () => {
    expect(
      buildArgs(
        { cwd: "/repo", model: "Gemini 3.1 Pro (High)", timeoutSec: 120 },
        cfg,
        "/tmp/run.log",
      ),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--add-dir",
      "/repo",
      "--log-file",
      "/tmp/run.log",
      "--model",
      "Gemini 3.1 Pro (High)",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "120s",
    ]);
  });

  it("falls back to cfg timeout; adds --conversation and --sandbox when set", () => {
    const args = buildArgs(
      { cwd: "/repo", conversationId: "abc-123" },
      { ...cfg, sandbox: true, skipPermissions: false },
      "/tmp/run.log",
    );
    expect(args).toEqual([
      "--sandbox",
      "--add-dir",
      "/repo",
      "--log-file",
      "/tmp/run.log",
      "--conversation",
      "abc-123",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "600s",
    ]);
  });
});

describe("stdinMessage", () => {
  it("wraps the prompt in one stream-json user event, newlines and quotes intact", () => {
    const prompt = 'Review this:\n+ const s = "x";';
    const line = stdinMessage(prompt);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      event: "user",
      message: { role: "user", content: prompt },
    });
  });
});

describe("truncate", () => {
  it("passes short output through", () => {
    expect(truncate("short", 100)).toEqual({ text: "short", truncated: false });
  });
  it("cuts long output with a notice", () => {
    const r = truncate("x".repeat(150), 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("x".repeat(100));
    expect(r.text).toMatch(/truncated at 100.*150/s);
  });
});

describe("execWithClosedStdin", () => {
  it("closes child stdin so stdin-reading commands exit instead of hanging", async () => {
    // `cat` is absent on Windows (ENOENT). Use node (always present under
    // vitest) reading stdin until EOF — execWithClosedStdin ends stdin at
    // once, so this echoes "" and exits 0 instead of hanging.
    const r = await execWithClosedStdin(
      process.execPath,
      [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{" +
          "process.stdout.write(d);process.exit(0)})",
      ],
      { cwd: process.cwd(), timeout: 5000, maxBuffer: 1024 },
    );
    expect(r.stdout).toBe("");
  });
});

describe("treeKill", () => {
  it("Windows branch invokes taskkill with /PID <pid> /T /F", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec: TreeKillExecFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };
    await treeKill(4321, "SIGTERM", exec, "win32");
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("taskkill");
    expect(calls[0].args).toEqual(["/PID", "4321", "/T", "/F"]);
  });

  it("Windows branch swallows a taskkill failure (process already gone)", async () => {
    const exec: TreeKillExecFn = async () => {
      throw new Error("not running");
    };
    await expect(treeKill(4321, "SIGTERM", exec, "win32")).resolves.toBeUndefined();
  });

  it("POSIX branch kills the whole process group via process.kill(-pid, signal)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const exec: TreeKillExecFn = async () => {
      throw new Error("exec must NOT be called on POSIX");
    };
    await treeKill(1234, "SIGTERM", exec, "linux");
    expect(killSpy).toHaveBeenCalledWith(-1234, "SIGTERM");
    killSpy.mockRestore();
  });

  it("POSIX branch falls back to child-only kill when the group is gone", async () => {
    let first = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      if (first) {
        first = false;
        throw new Error("ESRCH");
      }
      return true;
    });
    await treeKill(1234, "SIGTERM", async () => ({ stdout: "", stderr: "" }), "linux");
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, -1234, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, 1234, "SIGTERM");
    killSpy.mockRestore();
  });
});

describe("runAgy", () => {
  it("returns the answer and the conversation id from the stream", async () => {
    const f = fakeDeps({ lines: [init("conv-9"), result({ response: "answer\n" })] });
    const r = await runAgy(req(), cfg, f.deps);
    expect(r).toMatchObject({ state: "done", output: "answer", sessionId: "conv-9" });
    expect(f.spawnOpts()!.outPath).toBe(runPaths(cfg.runsDir, r.meta.runId).out);
    expect(f.spawnOpts()!.input).toBe(stdinMessage("q"));
    expect(f.args()).not.toContain("q");
  });

  it("hands back the session id and progress when the wait runs out, and collects the answer later", async () => {
    const f = fakeDeps({
      lines: [init(), toolStep("read_file", { Path: "/repo/src/server.ts", EndLine: 20 })],
      later: { lines: [result({ response: "late answer" })], afterMs: 150 },
    });
    const r = await runAgy(req({ waitSec: 0.05 }), cfg, f.deps);
    expect(r).toMatchObject({
      state: "running",
      sessionId: "conv-1",
      progress: "1 tool call so far, last: read_file /repo/src/server.ts",
    });
    expect(f.kills).toEqual([]);

    const later = await collectRun("conv-1", 5, cfg, f.deps);
    expect(later).toMatchObject({ state: "done", output: "late answer", sessionId: "conv-1" });
  });

  it("reports a turn its time limit cut short, with the session id to continue it", async () => {
    const f = fakeDeps({
      lines: [
        init(),
        toolStep("run_command", { CommandLine: "git status" }),
        result({ finished_reason: "print_timeout" }),
      ],
    });
    const err = (await runAgy(req({ timeoutSec: 45 }), cfg, f.deps).catch((e) => e)) as AgyRunError;
    expect(err).toBeInstanceOf(AgyRunError);
    expect(err.message).toMatch(/45s time limit ended the turn before it answered/);
    expect(err.message).toContain("1 tool call so far, last: run_command git status");
    expect(err.sessionId).toBe("conv-1");
  });

  it("includes a partial answer the time limit cut off", async () => {
    const f = fakeDeps({
      lines: [init(), result({ response: "half a review", finished_reason: "print_timeout" })],
    });
    const err = (await runAgy(req(), cfg, f.deps).catch((e) => e)) as AgyRunError;
    expect(err.message).toMatch(/before it finished.*half a review/s);
    expect(err.sessionId).toBe("conv-1");
  });

  it("surfaces agy's error from the result, with the session id", async () => {
    const f = fakeDeps({
      lines: [init(), result({ status: "ERROR", error: "auth expired", finished_reason: "error" })],
    });
    const err = (await runAgy(req(), cfg, f.deps).catch((e) => e)) as AgyRunError;
    expect(err.message).toMatch(/no answer: auth expired/);
    expect(err.sessionId).toBe("conv-1");
  });

  it("kills the child and throws QuotaError when the log shows a 429", async () => {
    const f = fakeDeps({ lines: [init()], neverExit: true, log: LOG_429 });
    await expect(runAgy(req({ model: "Gemini 3.8 Flash (Medium)" }), cfg, f.deps)).rejects.toThrow(
      QuotaError,
    );
    expect(f.kills).toContain("SIGTERM");
  });

  it("includes the reset time in the QuotaError", async () => {
    const f = fakeDeps({ neverExit: true, log: LOG_429 });
    const err = (await runAgy(req({ model: "M" }), cfg, f.deps).catch((e) => e)) as QuotaError;
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.resetSeconds).toBe(4 * 3600 + 24 * 60);
  });

  it("treats an empty answer with a quota log as QuotaError, not success", async () => {
    const f = fakeDeps({ lines: [init(), result({ response: "" })], log: LOG_429 });
    await expect(runAgy(req({ model: "M" }), cfg, f.deps)).rejects.toThrow(QuotaError);
  });

  it("treats a quota error in the result as QuotaError", async () => {
    const f = fakeDeps({
      lines: [init(), result({ status: "ERROR", error: `turn failed: ${LOG_429}` })],
    });
    await expect(runAgy(req({ model: "M" }), cfg, f.deps)).rejects.toThrow(QuotaError);
  });

  it("treats an empty answer with a clean log as an error, not success", async () => {
    const f = fakeDeps({ lines: [init(), result({ response: "  " })] });
    await expect(runAgy(req(), cfg, f.deps)).rejects.toThrow(/returned no answer/);
  });

  it("throws install guidance on ENOENT", async () => {
    const e = new Error("spawn agy ENOENT") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    const f = fakeDeps({ spawnError: e });
    await expect(runAgy(req(), cfg, f.deps)).rejects.toThrow(/not found.*antigravity/is);
  });

  it("surfaces stderr and the exit code when agy stops without an answer", async () => {
    const f = fakeDeps({ exitCode: 1, stderr: "auth expired" });
    await expect(runAgy(req(), cfg, f.deps)).rejects.toThrow(
      /without an answer \(exit code 1\): auth expired/,
    );
  });

  it("kills the child and rejects when the abort signal fires", async () => {
    const f = fakeDeps({ lines: [init()], neverExit: true });
    const ac = new AbortController();
    const p = runAgy(req({ signal: ac.signal }), cfg, f.deps);
    setTimeout(() => ac.abort(), 10);
    const err = (await p.catch((e) => e)) as AgyRunError;
    expect(err.message).toMatch(/cancelled/i);
    expect(err.sessionId).toBe("conv-1");
    expect(f.kills).toContain("SIGTERM");
  });

  it("stops an agy that outlives its time limit, escalating to SIGKILL", async () => {
    const f = fakeDeps({ lines: [init()], neverExit: true });
    await expect(runAgy(req({ timeoutSec: 0.05 }), cfg, f.deps)).rejects.toThrow(
      /didn't stop at its 0.05s time limit/,
    );
    expect(f.kills).toContain("SIGTERM");
    await new Promise((r) => setTimeout(r, 25)); // killGraceMs is 5 in fakes
    expect(f.kills).toContain("SIGKILL");
  });
});

describe("collectRun", () => {
  /** A run started by another server process: only its files are here. */
  async function foreignRun(lines: string[]) {
    await writeMeta(cfg.runsDir, {
      runId: "run-1",
      tool: "adversarial_review",
      model: "Gemini 4 Neon (High)",
      cwd: "/repo",
      startedAt: Date.now(),
      timeoutSec: 600,
      pid: 777,
    });
    writeFileSync(runPaths(cfg.runsDir, "run-1").out, lines.map((l) => `${l}\n`).join(""));
  }

  it("finds a finished run by its conversation id and returns its answer", async () => {
    await foreignRun([init("conv-7"), result({ response: "kept answer" })]);
    const r = await collectRun("conv-7", 1, cfg, fakeDeps().deps);
    expect(r).toMatchObject({ state: "done", output: "kept answer", sessionId: "conv-7" });
    expect(r.meta.model).toBe("Gemini 4 Neon (High)");
  });

  it("finds a run by its run id while agy hasn't reported a conversation id", async () => {
    await foreignRun([]);
    const f = fakeDeps();
    f.deps.isAlive = () => true;
    const r = await collectRun("run-1", 0.02, cfg, f.deps);
    expect(r).toMatchObject({ state: "running", sessionId: "run-1" });
  });

  it("reports a run whose process died without an answer", async () => {
    await foreignRun([init("conv-7")]);
    const err = (await collectRun("conv-7", 1, cfg, fakeDeps().deps).catch(
      (e) => e,
    )) as AgyRunError;
    expect(err.message).toMatch(/stopped without an answer/);
    expect(err.sessionId).toBe("conv-7");
  });

  it("stops waiting on abort without killing a run it didn't start", async () => {
    await foreignRun([init("conv-7")]);
    const f = fakeDeps();
    f.deps.isAlive = () => true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const ac = new AbortController();
    const p = collectRun("conv-7", 5, cfg, f.deps, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("points to follow_up for a session it has no run of", async () => {
    await expect(collectRun("conv-unknown", 1, cfg, fakeDeps().deps)).rejects.toThrow(
      /No agy-bridge run of session conv-unknown.*follow_up/s,
    );
  });
});
