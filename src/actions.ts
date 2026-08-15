/**
 * Doing something about what the board shows.
 *
 * Four verbs, each mapping onto a documented Claude Code flag rather than onto
 * anything reverse-engineered:
 *
 *   spawn     `claude --bg -p <prompt>`            start work in the background
 *   reprompt  `claude --resume <id> -p <prompt>`   another turn on the same session
 *   reroute   `claude --resume <id> --fork-session --model <m> -p <prompt>`
 *   stop      SIGINT to the session's pid
 *
 * There is a fifth thing a dashboard like this obviously wants — inject a prompt
 * into a session that is mid-turn — and it is deliberately absent. Each live
 * session has a Unix socket under `/run/user/<uid>/cc-socks/`, and driving it
 * would mean reverse-engineering an undocumented protocol that can change in any
 * release. `reprompt` on a busy session therefore *refuses*, and says to fork
 * instead. A tool that steers your agents through a private channel is a tool
 * that silently stops steering them one Tuesday.
 *
 * Everything here spawns processes, so nothing here runs unless the server was
 * started with actions explicitly enabled.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ActionContext {
  bin?: string;
  /** Refuse any cwd outside these roots. Empty means "anywhere", which is the caller's choice. */
  allowedRoots?: string[];
  timeoutMs?: number;
}

export interface ActionResult {
  ok: boolean;
  action: string;
  sessionId?: string;
  detail: string;
  /** Present for headless runs: what the CLI reported about the turn it just did. */
  result?: HeadlessResult;
}

/** The object `claude -p --output-format json` prints. */
export interface HeadlessResult {
  session_id: string;
  is_error: boolean;
  stop_reason?: string;
  num_turns?: number;
  duration_api_ms?: number;
  /** The CLI's own cost figure. Reported, not derived — see pricing.ts. */
  total_cost_usd?: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
  permission_denials?: unknown[];
  terminal_reason?: string;
}

function bin(ctx: ActionContext): string {
  return ctx.bin ?? process.env.LOCALFLOW_CLAUDE_BIN ?? "claude";
}

/**
 * A prompt is untrusted input that becomes a process argument.
 *
 * It is passed through `execFile`/`spawn` with an argument array and never
 * through a shell, so there is nothing to escape. What is checked here is only
 * that it is a prompt at all: an empty one starts a session that immediately
 * asks what you wanted.
 */
export function checkPrompt(prompt: string): string | null {
  if (typeof prompt !== "string" || !prompt.trim()) return "prompt is empty";
  if (prompt.length > 100_000) return "prompt is longer than 100k characters";
  return null;
}

export function checkCwd(cwd: string, ctx: ActionContext): string | null {
  if (!cwd) return "no working directory given";
  if (!existsSync(cwd)) return `no such directory: ${cwd}`;
  const roots = ctx.allowedRoots ?? [];
  if (roots.length && !roots.some((r) => cwd === r || cwd.startsWith(`${r}/`))) {
    return `${cwd} is outside the allowed roots (${roots.join(", ")})`;
  }
  return null;
}

export interface SpawnRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  agent?: string;
}

/**
 * Start a background agent.
 *
 * `--bg` returns as soon as the session is registered rather than when the work
 * is done, which is what makes it usable from a dashboard: the card appears in
 * the next poll and you watch it there.
 */
export async function spawnAgent(req: SpawnRequest, ctx: ActionContext = {}): Promise<ActionResult> {
  const bad = checkPrompt(req.prompt) ?? checkCwd(req.cwd, ctx);
  if (bad) return { ok: false, action: "spawn", detail: bad };

  const args = ["--bg", "-p", req.prompt];
  if (req.model) args.push("--model", req.model);
  if (req.effort) args.push("--effort", req.effort);
  if (req.agent) args.push("--agent", req.agent);

  return await new Promise<ActionResult>((resolve) => {
    const child = spawn(bin(ctx), args, {
      cwd: req.cwd,
      // Detached with stdio ignored: the agent outlives this request, and the
      // board is how you watch it. Holding pipes open would make the server the
      // parent of every agent on the machine.
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (e) =>
      resolve({ ok: false, action: "spawn", detail: `could not start ${bin(ctx)}: ${e.message}` }),
    );
    child.on("spawn", () => {
      child.unref();
      resolve({
        ok: true,
        action: "spawn",
        detail: `background agent started in ${req.cwd}. It appears on the board within one poll.`,
      });
    });
  });
}

/**
 * Another turn on an existing session.
 *
 * Refuses while the session is busy. There is no supported way to add a turn to
 * a session that is mid-turn, and doing it unsupported would work until it did
 * not.
 */
export async function reprompt(
  sessionId: string,
  prompt: string,
  opts: { status?: string; cwd?: string; model?: string } = {},
  ctx: ActionContext = {},
): Promise<ActionResult> {
  const bad = checkPrompt(prompt);
  if (bad) return { ok: false, action: "reprompt", sessionId, detail: bad };
  if (opts.status === "busy") {
    return {
      ok: false,
      action: "reprompt",
      sessionId,
      detail:
        "this session is mid-turn. Claude Code has no supported way to inject a prompt into a " +
        "running turn, so localflow will not try. Wait for it to go idle, or reroute it into a fork.",
    };
  }
  const args = ["--resume", sessionId, "-p", prompt, "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);
  return await headless("reprompt", args, sessionId, opts.cwd, ctx);
}

/**
 * Fork a session onto a different model or agent.
 *
 * `--fork-session` keeps the conversation and gives it a new id, so the original
 * is left exactly as it was. That is the honest shape for "reroute": you are not
 * moving a session between models, you are starting a second one that remembers
 * everything the first knew.
 */
export async function reroute(
  sessionId: string,
  opts: { model?: string; agent?: string; effort?: string; prompt?: string; cwd?: string },
  ctx: ActionContext = {},
): Promise<ActionResult> {
  if (!opts.model && !opts.agent && !opts.effort) {
    return { ok: false, action: "reroute", sessionId, detail: "reroute needs a model, an agent or an effort level" };
  }
  const prompt = opts.prompt?.trim() || "Continue from where the previous session left off.";
  const args = ["--resume", sessionId, "--fork-session", "-p", prompt, "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.effort) args.push("--effort", opts.effort);
  return await headless("reroute", args, sessionId, opts.cwd, ctx);
}

async function headless(
  action: string,
  args: string[],
  sessionId: string,
  cwd: string | undefined,
  ctx: ActionContext,
): Promise<ActionResult> {
  try {
    const { stdout } = await run(bin(ctx), args, {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      maxBuffer: 32 << 20,
      timeout: ctx.timeoutMs ?? 15 * 60_000,
    });
    const result = JSON.parse(stdout) as HeadlessResult;
    return {
      ok: !result.is_error,
      action,
      sessionId: result.session_id ?? sessionId,
      detail: result.is_error
        ? `the turn ended with an error (${result.terminal_reason ?? "no reason given"})`
        : `turn completed${result.total_cost_usd !== undefined ? ` — the CLI reports $${result.total_cost_usd.toFixed(4)}` : ""}`,
      result,
    };
  } catch (e) {
    return { ok: false, action, sessionId, detail: `${bin(ctx)} failed: ${(e as Error).message}` };
  }
}

/**
 * Interrupt a session.
 *
 * SIGINT rather than SIGKILL: it is what Ctrl-C sends, so the session gets to
 * shut down the way it normally would. Killing it outright would leave a
 * transcript that stops mid-sentence and a lock file nobody cleans up.
 */
export function stopSession(pid: number | undefined, sessionId: string): ActionResult {
  if (!pid) {
    return { ok: false, action: "stop", sessionId, detail: "no pid recorded — this session is already ended" };
  }
  try {
    process.kill(pid, "SIGINT");
    return { ok: true, action: "stop", sessionId, detail: `SIGINT sent to pid ${pid}` };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return { ok: false, action: "stop", sessionId, detail: `pid ${pid} is no longer running` };
    }
    if (err.code === "EPERM") {
      return { ok: false, action: "stop", sessionId, detail: `not permitted to signal pid ${pid}` };
    }
    return { ok: false, action: "stop", sessionId, detail: `could not signal pid ${pid}: ${err.message}` };
  }
}
