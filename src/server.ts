import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { ModelRegistry } from "./models.js";
import { z } from "zod";
import {
  AgyRunError,
  collectRun,
  defaultDeps,
  execWithClosedStdin,
  runAgy,
  type RunOutcome,
  type RunnerDeps,
} from "./runner.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import { TOOLS, type ToolDef } from "./tools.js";

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface HandlerExtra {
  signal?: AbortSignal;
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  registry: ModelRegistry,
  deps: RunnerDeps = defaultDeps,
  cooldowns: CooldownRegistry = new CooldownRegistry(),
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();
      const conversationId = args.session_id as string | undefined;
      const prompt = tool.buildPrompt(args, cwd);
      const timeoutSec =
        (args.timeout_sec as number | undefined) ??
        cfg.perToolTimeouts[tool.name] ??
        (cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec);

      const resolution = conversationId
        ? { models: [undefined], note: undefined }
        : await registry.resolveChain({
            explicit: args.model as string | undefined,
            chain: tool.chain,
            defaultModel: cfg.defaultModel,
          });

      const attempts: string[] = [];
      let result: RunOutcome | undefined;

      for (const model of resolution.models) {
        if (model && cooldowns.cooling(model)) {
          attempts.push(`${model}: quota cooldown, ${cooldowns.describe(model)} left`);
          continue;
        }
        try {
          result = await runAgy(
            {
              tool: tool.name,
              prompt,
              cwd,
              model,
              conversationId,
              timeoutSec,
              waitSec: cfg.waitSec,
              signal: extra?.signal,
            },
            cfg,
            deps,
          );
          break;
        } catch (err) {
          if (err instanceof QuotaError && model) {
            cooldowns.set(model, err.resetSeconds);
            attempts.push(
              `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
            );
            continue;
          }
          throw err;
        }
      }

      if (!result) {
        throw new Error(
          `All candidate models are quota-exhausted or cooling down:\n` +
            `${attempts.map((a) => `- ${a}`).join("\n")}\n` +
            `Retry after the quota resets, or pass an explicit \`model\`.`,
        );
      }

      const notes: string[] = [];
      if (resolution.note) notes.push(`note: ${resolution.note}`);
      if (attempts.length) notes.push(`failover: ${attempts.join("; ")}`);
      return formatOutcome(result, notes);
    } catch (err) {
      return formatError(err, cfg);
    }
  };
}

/** Handler for get_result: waits again for a run that outlived the call that started it. */
export function createResultHandler(
  cfg: Config,
  deps: RunnerDeps = defaultDeps,
  cooldowns: CooldownRegistry = new CooldownRegistry(),
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    try {
      const sessionId = args.session_id as string;
      const waitSec = (args.wait_sec as number | undefined) ?? cfg.waitSec;
      return formatOutcome(await collectRun(sessionId, waitSec, cfg, deps, extra?.signal), []);
    } catch (err) {
      // get_result doesn't have the prompt to fail over with, so the caller re-runs
      // the tool, which then skips the exhausted model.
      if (err instanceof QuotaError && err.model) {
        cooldowns.set(err.model, err.resetSeconds);
        return formatError(
          new Error(
            `${err.message} It ran out while agy was working, so this run has no answer. ` +
              `Run the original tool call again: it will go to the next model in its chain.`,
          ),
          cfg,
        );
      }
      return formatError(err, cfg);
    }
  };
}

function formatOutcome(result: RunOutcome, notes: string[]): ToolResponse {
  const footer = [`model: ${result.meta.model ?? "agy default"}`, ...notes];
  if (result.state === "running") {
    footer.push(`session: ${result.sessionId}`);
    const text =
      `[agy-bridge] agy is still working after ${result.elapsedSec}s (${result.progress}). ` +
      `Nothing is lost: its answer is being kept. Call get_result with ` +
      `session_id "${result.sessionId}" to wait for it.`;
    return {
      content: [{ type: "text", text: `${text}\n\n---\n[agy-bridge] ${footer.join(" | ")}` }],
    };
  }
  if (result.sessionId) footer.push(`session: ${result.sessionId} (use follow_up to continue)`);
  return {
    content: [
      { type: "text", text: `${result.output}\n\n---\n[agy-bridge] ${footer.join(" | ")}` },
    ],
  };
}

function formatError(err: unknown, cfg: Config): ToolResponse {
  let text = (err as Error).message;
  if (err instanceof AgyRunError && err.sessionId) {
    text +=
      `\n\n[agy-bridge] session: ${err.sessionId} — follow_up can continue this conversation, ` +
      `for example to ask for its answer so far.`;
  }
  if (cfg.onFailure === "strict") {
    text +=
      "\n\n[agy-bridge strict mode] Delegation failed. Do NOT perform this work yourself " +
      "in the main context — report the failure to the user and let them decide how to proceed.";
  }
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

export function createServer(): McpServer {
  const cfg = loadConfig();
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execWithClosedStdin(cfg.agyPath, ["models"], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  });
  const cooldowns = new CooldownRegistry();

  const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
  const server = new McpServer({ name: "agy-bridge", version });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, registry, defaultDeps, cooldowns),
    );
  }
  server.registerTool(
    "get_result",
    {
      description:
        "Collect the answer of an agy-bridge call that returned while agy was still working " +
        "(it says so and gives a session_id). Waits up to wait_sec for agy to finish and returns " +
        "its answer; if agy is still working, reports how far it has got so you can call again. " +
        "Runs outlive the call that started them, and this server restarting.",
      inputSchema: {
        session_id: z.string().describe("The session_id the earlier call returned."),
        wait_sec: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe(
            "How long to wait for the answer, in seconds. Defaults to AGY_WAIT_SEC; " +
              "keep it below the MCP client's tool timeout.",
          ),
      },
    },
    createResultHandler(cfg, defaultDeps, cooldowns),
  );
  return server;
}
