import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Each agy run writes its stream-json output, stderr and log to files here, so
 * the answer survives the MCP call that started it and even this server.
 */
export const DEFAULT_RUNS_DIR = path.join(homedir(), ".cache", "agy-bridge", "runs");

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_OTHER_OUTPUT_CHARS = 8 * 1024;
const MAX_TOOL_DETAIL_CHARS = 60;

export interface RunMeta {
  runId: string;
  tool: string;
  model?: string;
  cwd: string;
  pid?: number;
  /** Epoch milliseconds. */
  startedAt: number;
  timeoutSec: number;
  /** Known up front for a follow_up; otherwise read from the stream's init event. */
  conversationId?: string;
}

export interface RunPaths {
  meta: string;
  out: string;
  err: string;
  log: string;
}

export function runPaths(dir: string, runId: string): RunPaths {
  const base = path.join(dir, runId);
  return {
    meta: `${base}.json`,
    out: `${base}.jsonl`,
    err: `${base}.err`,
    log: `${base}.log`,
  };
}

export async function writeMeta(dir: string, meta: RunMeta): Promise<void> {
  // The stream holds file contents agy read, so keep it private to the user.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(runPaths(dir, meta.runId).meta, JSON.stringify(meta), { mode: 0o600 });
}

/** The latest run of a conversation, by its conversation id or by its run id. */
export async function findRun(dir: string, id: string): Promise<RunMeta | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let latest: RunMeta | undefined;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const meta = await readMeta(path.join(dir, name));
    if (!meta) continue;
    const conversationId =
      meta.conversationId ?? (await readInitConversationId(runPaths(dir, meta.runId).out));
    if (meta.runId !== id && conversationId !== id) continue;
    if (!latest || meta.startedAt > latest.startedAt) latest = { ...meta, conversationId };
  }
  return latest;
}

/** Removes the files of runs started more than three days ago. */
export async function pruneRuns(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const meta = await readMeta(path.join(dir, name));
    if (!meta || now - meta.startedAt < RETENTION_MS) continue;
    const paths = runPaths(dir, meta.runId);
    await Promise.all(
      [paths.out, paths.err, paths.log, paths.meta].map((p) => rm(p, { force: true })),
    );
  }
}

async function readMeta(file: string): Promise<RunMeta | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as RunMeta;
  } catch {
    return undefined;
  }
}

async function readInitConversationId(out: string): Promise<string | undefined> {
  const reader = new StreamReader(out);
  return (await reader.poll()).conversationId;
}

export interface AgyResult {
  status: string;
  response: string;
  error?: string;
  /** Set only when the turn ended early: `print_timeout`, `interrupted` or `error`. */
  finishedReason?: string;
}

export interface StreamState {
  conversationId?: string;
  toolCalls: number;
  lastTool?: string;
  result?: AgyResult;
  /** Lines that aren't stream events, such as a CLI error printed before the stream starts. */
  otherOutput: string;
}

/** Reads an agy `--output-format stream-json` file incrementally, keeping only what the bridge needs. */
export class StreamReader {
  readonly state: StreamState = { toolCalls: 0, otherOutput: "" };
  private offset = 0;
  private partial = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly file: string) {}

  async poll(): Promise<StreamState> {
    let handle;
    try {
      handle = await open(this.file, "r");
    } catch {
      return this.state;
    }
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(this.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } finally {
      await handle.close();
    }
    return this.state;
  }

  private consume(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) applyStreamLine(this.state, line);
  }
}

export function applyStreamLine(state: StreamState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    if (state.otherOutput.length < MAX_OTHER_OUTPUT_CHARS) state.otherOutput += `${trimmed}\n`;
    return;
  }
  switch (event.event) {
    case "init":
      state.conversationId ??= event.conversation_id as string | undefined;
      break;
    case "step_update": {
      const step = event.step_update as StepUpdate | undefined;
      if (step?.step_type !== "tool") break;
      state.lastTool = describeTool(step);
      if (step.state === "DONE") state.toolCalls++;
      break;
    }
    case "result": {
      const r = (event.result ?? {}) as Record<string, unknown>;
      state.conversationId ??= r.conversation_id as string | undefined;
      state.result = {
        status: String(r.status ?? ""),
        response: String(r.response ?? ""),
        error: r.error ? String(r.error) : undefined,
        finishedReason: r.finished_reason ? String(r.finished_reason) : undefined,
      };
      break;
    }
  }
}

interface StepUpdate {
  step_type?: string;
  state?: string;
  tool_name?: string;
  tool_info?: { parameters?: Record<string, unknown> };
}

function describeTool(step: StepUpdate): string {
  const name = step.tool_name ?? "tool";
  const params = step.tool_info?.parameters ?? {};
  const detail = Object.values(params).find((v): v is string => typeof v === "string" && !!v);
  if (!detail) return name;
  const oneLine = detail.replace(/\s+/g, " ");
  const short =
    oneLine.length > MAX_TOOL_DETAIL_CHARS ? `…${oneLine.slice(-MAX_TOOL_DETAIL_CHARS)}` : oneLine;
  return `${name} ${short}`;
}

export function describeProgress(state: StreamState): string {
  const calls = `${state.toolCalls} tool call${state.toolCalls === 1 ? "" : "s"} so far`;
  return state.lastTool ? `${calls}, last: ${state.lastTool}` : calls;
}
