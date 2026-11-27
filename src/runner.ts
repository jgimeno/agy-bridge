import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { detectQuota, QuotaError } from "./quota.js";
import {
  StreamReader,
  describeProgress,
  findRun,
  pruneRuns,
  runPaths,
  writeMeta,
  type RunMeta,
  type StreamState,
} from "./runs.js";

const execFileAsync = promisify(execFile);

export interface RunRequest {
  /** The tool that started the run, recorded with it. */
  tool: string;
  prompt: string;
  cwd: string;
  model?: string;
  conversationId?: string;
  /** agy's own time limit for the whole run; falls back to cfg.timeoutSec. */
  timeoutSec?: number;
  /** How long this call waits for the answer before handing back the session id. */
  waitSec: number;
  /** MCP cancellation signal — kills the agy process when aborted. */
  signal?: AbortSignal;
}

export type RunOutcome =
  | { state: "done"; output: string; truncated: boolean; sessionId?: string; meta: RunMeta }
  | {
      state: "running";
      /** The conversation id, or the run id while agy hasn't reported one yet. */
      sessionId: string;
      progress: string;
      elapsedSec: number;
      meta: RunMeta;
    };

/** A failed run, carrying the conversation id when agy reported one so it can be continued. */
export class AgyRunError extends Error {
  constructor(
    message: string,
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = "AgyRunError";
  }
}

export interface ChildHandle {
  pid?: number;
  /** Settles when the process exits, or fails to spawn. */
  wait(): Promise<{ code: number | null; error?: NodeJS.ErrnoException }>;
  /** Signals the whole process group so web-search helpers can't outlive agy. */
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  cwd: string;
  /** Written to stdin, which is then closed; agy reads stdin until EOF. */
  input?: string;
  outPath: string;
  errPath: string;
}

export interface RunnerDeps {
  spawnChild(file: string, args: string[], opts: SpawnOptions): ChildHandle;
  /** Whether a run's process is still alive when this server didn't start it. */
  isAlive(pid: number): boolean;
  /** How often to read the run's stream and log. */
  pollMs?: number;
  /** Extra wait beyond agy's own --print-timeout before we hard-kill. */
  graceMs?: number;
  /** Delay between SIGTERM and SIGKILL escalation. */
  killGraceMs?: number;
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

// agy reads stdin until EOF even in print mode; an open stdin pipe hangs it forever.
export const execWithClosedStdin: ExecFn = (file, args, options) => {
  const promise = execFileAsync(file, args, { windowsHide: true, ...options });
  promise.child.stdin?.end();
  return promise;
};

/**
 * Subprocess executor used by treeKill (taskkill on Windows). Injectable so the
 * kill path is unit-testable without spawning real processes.
 */
export type TreeKillExecFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export const defaultTreeKillExec: TreeKillExecFn = (file, args) =>
  // windowsHide: taskkill is a console app and would flash a window (#20).
  execFileAsync(file, args, { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });

/**
 * Cross-platform process-tree kill. Replaces the Windows-broken
 * `process.kill(-pid)` (Node throws on negative pids under win32, orphaning
 * grandchildren like web-search helpers). Windows has no signal semantics for
 * a process group, so it always force-kills the tree via `taskkill /T /F`;
 * POSIX stays signal-aware via the negative-pid group kill, falling back to a
 * child-only kill if the group is already gone. Both branches are no-ops once
 * the target has exited.
 */
export async function treeKill(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  exec: TreeKillExecFn = defaultTreeKillExec,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") {
    try {
      await exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // process tree already gone — nothing to do
    }
    return;
  }
  try {
    process.kill(-pid, signal); // whole process group
  } catch {
    try {
      process.kill(pid, signal); // group leader already reaped — child only
    } catch {
      // already gone
    }
  }
}

function spawnDetached(file: string, args: string[], opts: SpawnOptions): ChildHandle {
  // agy writes straight to the run's files rather than to pipes, so it keeps
  // running, and its answer stays readable, if this server exits.
  const out = openSync(opts.outPath, "a", 0o600);
  const err = openSync(opts.errPath, "a", 0o600);
  let child;
  try {
    // detached gives POSIX a process group to kill; on Windows it maps to
    // DETACHED_PROCESS, which makes agy and its MCP children pop console windows (#20).
    child = spawn(file, args, {
      cwd: opts.cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", out, err],
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  if (child.stdin) {
    child.stdin.on("error", () => {}); // agy exiting early must not crash the server
    child.stdin.end(opts.input);
  }
  child.unref();

  let exited = false;
  const done = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      resolve({ code });
    });
    child.on("error", (e) => {
      exited = true;
      resolve({ code: null, error: e as NodeJS.ErrnoException });
    });
  });

  return {
    pid: child.pid,
    wait: () => done,
    kill: (signal) => {
      // No-op once the child exited: its (negative) PID may already belong to
      // an unrelated process group. treeKill is fire-and-forget here to keep
      // the synchronous `void` contract.
      if (exited || child.pid === undefined) return;
      void treeKill(child.pid, signal).catch(() => {});
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const defaultDeps: RunnerDeps = {
  spawnChild: spawnDetached,
  isAlive: isProcessAlive,
};

export function buildArgs(
  req: Pick<RunRequest, "cwd" | "model" | "conversationId" | "timeoutSec">,
  cfg: Config,
  logPath: string,
): string[] {
  const timeoutSec = req.timeoutSec ?? cfg.timeoutSec;
  const args: string[] = [];
  if (cfg.skipPermissions) args.push("--dangerously-skip-permissions");
  if (cfg.sandbox) args.push("--sandbox");
  args.push("--add-dir", req.cwd);
  args.push("--log-file", logPath);
  if (req.conversationId) args.push("--conversation", req.conversationId);
  if (req.model) args.push("--model", req.model);
  // The prompt goes over stdin (see stdinMessage): an argument would show it in
  // `ps` and hit the OS argument-size limit with a large diff to review.
  args.push("--input-format", "stream-json", "--output-format", "stream-json");
  args.push("--print-timeout", `${timeoutSec}s`);
  return args;
}

/** The prompt as the one user message agy's `--input-format stream-json` reads from stdin. */
export function stdinMessage(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text:
      `${text.slice(0, max)}\n\n[agy-bridge: output truncated at ${max} chars; ` +
      `full length was ${text.length} chars. Ask a narrower question or raise AGY_MAX_OUTPUT_CHARS.]`,
    truncated: true,
  };
}

/** Children this server started, so their exit is seen directly instead of by polling the PID. */
interface LiveRun {
  child: ChildHandle;
  exit?: { code: number | null; error?: NodeJS.ErrnoException };
}
const liveRuns = new Map<string, LiveRun>();

/**
 * Starts agy and waits up to `req.waitSec` for its answer. agy keeps running
 * after that; its stream stays on disk for `collectRun`.
 */
export async function runAgy(
  req: RunRequest,
  cfg: Config,
  deps: RunnerDeps = defaultDeps,
): Promise<RunOutcome> {
  void pruneRuns(cfg.runsDir).catch(() => {});
  const meta: RunMeta = {
    runId: randomUUID(),
    tool: req.tool,
    model: req.model,
    cwd: req.cwd,
    startedAt: Date.now(),
    timeoutSec: req.timeoutSec ?? cfg.timeoutSec,
    conversationId: req.conversationId,
  };
  const paths = runPaths(cfg.runsDir, meta.runId);
  await writeMeta(cfg.runsDir, meta);

  const child = deps.spawnChild(cfg.agyPath, buildArgs(req, cfg, paths.log), {
    cwd: req.cwd,
    input: stdinMessage(req.prompt),
    outPath: paths.out,
    errPath: paths.err,
  });
  const live: LiveRun = { child };
  liveRuns.set(meta.runId, live);
  void child.wait().then((exit) => {
    live.exit = exit;
    // Keep the record a little longer than any wait could still be reading it.
    setTimeout(() => liveRuns.delete(meta.runId), 60_000).unref?.();
  });

  meta.pid = child.pid;
  await writeMeta(cfg.runsDir, meta);

  // agy's --print-timeout should end the run first; this catches an agy that doesn't.
  const graceMs = deps.graceMs ?? 15_000;
  const watchdog = setTimeout(
    () => {
      if (!live.exit) killRun(live, deps);
    },
    meta.timeoutSec * 1000 + graceMs,
  );
  watchdog.unref?.();
  void child.wait().then(() => clearTimeout(watchdog));

  return awaitRun(meta, req.waitSec, cfg, deps, req.signal);
}

/** Waits up to `waitSec` for a run started earlier, by its session (conversation) id or run id. */
export async function collectRun(
  sessionId: string,
  waitSec: number,
  cfg: Config,
  deps: RunnerDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const meta = await findRun(cfg.runsDir, sessionId);
  if (!meta) {
    throw new AgyRunError(
      `No agy-bridge run of session ${sessionId} is recorded in ${cfg.runsDir}. ` +
        `follow_up can still ask that conversation for its answer.`,
      sessionId,
    );
  }
  return awaitRun(meta, waitSec, cfg, deps, signal, false);
}

function killRun(live: LiveRun, deps: RunnerDeps): void {
  live.child.kill("SIGTERM");
  // Escalation must outlive the wait — kill() no-ops once the child has exited.
  const escalate = setTimeout(() => live.child.kill("SIGKILL"), deps.killGraceMs ?? 5_000);
  escalate.unref?.();
}

async function awaitRun(
  meta: RunMeta,
  waitSec: number,
  cfg: Config,
  deps: RunnerDeps,
  signal: AbortSignal | undefined,
  cancelKills = true,
): Promise<RunOutcome> {
  const paths = runPaths(cfg.runsDir, meta.runId);
  const reader = new StreamReader(paths.out);
  const pollMs = deps.pollMs ?? 1000;
  const graceMs = deps.graceMs ?? 15_000;
  const waitStart = Date.now();
  const deadline = meta.startedAt + meta.timeoutSec * 1000 + graceMs;
  const sessionOf = (state: StreamState) => state.conversationId ?? meta.conversationId;

  for (;;) {
    const state = await reader.poll();
    if (state.result) return finish(meta, state, cfg);

    const quota = detectQuota(await readText(paths.log));
    const live = liveRuns.get(meta.runId);
    if (quota) {
      if (live) killRun(live, deps);
      throw new QuotaError(meta.model, quota);
    }

    if (signal?.aborted) {
      // Only the call that started agy stops it; a caller collecting the result just stops waiting.
      if (live && cancelKills) killRun(live, deps);
      throw new AgyRunError("agy run cancelled by client.", sessionOf(state));
    }

    const exit = live ? live.exit : meta.pid && !deps.isAlive(meta.pid) ? {} : undefined;
    if (exit) {
      // It may have written its result just before exiting.
      const last = await reader.poll();
      if (last.result) return finish(meta, last, cfg);
      throw await stoppedWithoutResult(meta, last, exit, sessionOf(last), cfg);
    }

    if (Date.now() > deadline) {
      if (live) killRun(live, deps);
      throw new AgyRunError(
        `agy didn't stop at its ${meta.timeoutSec}s time limit, so it was stopped ` +
          `(${describeProgress(state)}).`,
        sessionOf(state),
      );
    }

    const elapsedMs = Date.now() - waitStart;
    if (elapsedMs >= waitSec * 1000) {
      return {
        state: "running",
        sessionId: sessionOf(state) ?? meta.runId,
        progress: describeProgress(state),
        elapsedSec: Math.round((Date.now() - meta.startedAt) / 1000),
        meta,
      };
    }
    await sleep(Math.min(pollMs, waitSec * 1000 - elapsedMs), signal);
  }
}

async function finish(meta: RunMeta, state: StreamState, cfg: Config): Promise<RunOutcome> {
  const result = state.result!;
  const sessionId = state.conversationId ?? meta.conversationId;
  const response = result.response.trim();

  if (result.finishedReason === "print_timeout") {
    const limit = `agy's ${meta.timeoutSec}s time limit ended the turn`;
    throw new AgyRunError(
      response
        ? `${limit} before it finished (${describeProgress(state)}). Its partial answer:\n\n${response}`
        : `${limit} before it answered (${describeProgress(state)}).`,
      sessionId,
    );
  }

  if (result.status !== "SUCCESS" || result.finishedReason || !response) {
    const quota = detectQuota(
      `${await readText(runPaths(cfg.runsDir, meta.runId).log)}\n${result.error ?? ""}`,
    );
    if (quota) throw new QuotaError(meta.model, quota);
    throw new AgyRunError(
      response
        ? `agy failed: ${result.error ?? result.finishedReason ?? result.status}`
        : `agy returned no answer${result.error ? `: ${result.error}` : "."}`,
      sessionId,
    );
  }

  const { text, truncated } = truncate(response, cfg.maxOutputChars);
  return { state: "done", output: text, truncated, sessionId, meta };
}

async function stoppedWithoutResult(
  meta: RunMeta,
  state: StreamState,
  exit: { code?: number | null; error?: NodeJS.ErrnoException },
  sessionId: string | undefined,
  cfg: Config,
): Promise<Error> {
  if (exit.error?.code === "ENOENT") {
    return new Error(
      `agy CLI not found at "${cfg.agyPath}". Install the Antigravity CLI ` +
        `(https://antigravity.google/docs/cli-getting-started) or set AGY_PATH.`,
    );
  }
  if (exit.error) return new AgyRunError(`agy failed: ${exit.error.message}`, sessionId);
  const stderr = (await readText(runPaths(cfg.runsDir, meta.runId).err, 4096)).trim();
  const detail = [stderr, state.otherOutput.trim()].filter(Boolean).join("\n");
  const code = exit.code === undefined ? "" : ` (exit code ${exit.code})`;
  return new AgyRunError(
    `agy stopped without an answer${code}${detail ? `: ${detail}` : "."}`,
    sessionId,
  );
}

async function readText(file: string, maxChars = 256 * 1024): Promise<string> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return "";
  }
  try {
    // A long run's log can grow large; quota lines are near its end.
    const { size } = await handle.stat();
    const length = Math.min(size, maxChars);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
