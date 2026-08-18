/**
 * The localflow server.
 *
 * Node's own `http`, no framework, because the whole surface is a dozen routes
 * and a stream. What deserves attention is not the routing but the guards, so
 * they are at the top of the file.
 *
 * This process can start Claude Code sessions on your machine. A page on the
 * open internet can send your browser to `http://127.0.0.1:7317/`, and unless
 * something stops it, that page can POST to this server with your loopback
 * address as the source. Three things stop it:
 *
 *   1. **Actions are off unless asked for.** Without `--allow-actions` every
 *      mutating route answers 403. Watching is the default; steering is opted
 *      into.
 *   2. **Host is checked.** DNS rebinding works by resolving an attacker's
 *      hostname to 127.0.0.1, and the give-away is the `Host` header — it says
 *      `evil.example` where a real local request says `localhost`. Anything else
 *      is refused.
 *   3. **Origin is checked.** A cross-site POST carries the originating site in
 *      `Origin`. A same-origin fetch from our own page carries ours; curl sends
 *      none. Any other value is refused.
 *
 * Bound to loopback by default, and binding anywhere else has to be spelled out.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, normalize, resolve as resolvePath } from "node:path";

import { reprompt, reroute, spawnAgent, stopSession } from "./actions.js";
import type { ActionContext } from "./actions.js";
import { Board } from "./board.js";
import type { BoardOptions } from "./board.js";
import { notesFor, observedSpec } from "./graph.js";
import { otterTasks, otterUrl } from "./otter.js";
import { summarise } from "./board.js";
import { AdapterRegistry } from "./agents/registry.js";
import type { AdapterStatus } from "./agents/registry.js";
import { computeMetrics } from "./metrics.js";
import { externalPricing, reloadPricing } from "./pricing.js";
import { pricingPath, stalenessDays } from "./providers.js";
import { sourcesPath } from "./agents/jsonl.js";
import { listSessions } from "./sessions.js";
import { countTasks, createTask, readTasks, setTaskStatus } from "./tasks.js";
import type { TaskStatus } from "./tasks.js";
import type { BoardSummary, Task } from "./types.js";

export interface ServerOptions extends BoardOptions {
  port?: number;
  host?: string;
  /** Enables every mutating route. Off by default, on purpose. */
  allowActions?: boolean;
  /** Restrict where `spawn` may run. */
  allowedRoots?: string[];
  /** Board refresh interval, milliseconds. */
  pollMs?: number;
  /** Directory holding the built UI. */
  webRoot?: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** True when the `Host` header names this machine rather than someone's domain. */
export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  // Strip the port, minding IPv6 literals like `[::1]:7317`.
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim());
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  const p = m[2];
  if (p && Number(p) !== port) return false;
  return LOCAL_HOSTNAMES.has(name);
}

/** True when the request either came from our own page or from no page at all. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin || origin === "null") return true; // curl, fetch from a script, same-origin GET
  try {
    const u = new URL(origin);
    return LOCAL_HOSTNAMES.has(u.hostname.toLowerCase()) && (!u.port || Number(u.port) === port);
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

export class LocalflowServer {
  private readonly board: Board;
  private readonly opts: Required<Pick<ServerOptions, "port" | "host" | "pollMs">> & ServerOptions;
  private readonly clients = new Set<ServerResponse>();
  private latest: BoardSummary | null = null;
  private lastError: string | null = null;
  private readonly registry = new AdapterRegistry();
  private adapterStatus: AdapterStatus[] = [];
  private sourcesError: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private http: Server | null = null;

  constructor(opts: ServerOptions = {}) {
    this.opts = { port: 7317, host: "127.0.0.1", pollMs: 2_000, ...opts };
    this.board = new Board(opts);
    // Declared sources are read once at construction. Editing sources.json is
    // a restart, which is the right cost for a file that changes about as often
    // as you install a new agent CLI.
    this.sourcesError = this.registry.addDeclared().error;
  }

  async start(): Promise<{ url: string }> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.pollMs);
    this.timer.unref?.();

    this.http = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.http!.listen(this.opts.port, this.opts.host, r));
    return { url: `http://${this.opts.host}:${this.opts.port}/` };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  /** The current board, for tests and for the CLI's one-shot mode. */
  get snapshot(): BoardSummary | null {
    return this.latest;
  }

  private async refresh(): Promise<void> {
    try {
      const summary = await this.board.poll();
      if (otterUrl(this.opts)) {
        const { tasks, error } = await otterTasks(this.opts);
        if (error) summary.degraded.push({ id: "otter", reason: error });
        if (tasks.length) {
          Object.assign(summary, summarise([...summary.tasks, ...tasks], summary.degraded, this.opts.asOf));
        }
      }

      // Everything declared in sources.json. Merged the same way Otter is, so
      // a card from another tool is a card like any other on the board.
      const extra = await this.registry.poll({ asOf: this.opts.asOf, history: this.opts.history });
      this.adapterStatus = extra.adapters;
      if (this.sourcesError) summary.degraded.push({ id: "sources", reason: this.sourcesError });
      summary.degraded.push(...extra.degraded);
      if (extra.tasks.length) {
        Object.assign(
          summary,
          summarise([...summary.tasks, ...extra.tasks], summary.degraded, this.opts.asOf),
        );
      }
      this.latest = summary;
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
    this.broadcast();
  }

  private broadcast(): void {
    if (!this.clients.size) return;
    const payload = JSON.stringify(this.latest ?? { error: this.lastError });
    for (const c of this.clients) {
      // A slow reader must not wedge the poll loop; if the socket has gone the
      // write throws and the client is dropped on the next pass.
      try {
        c.write(`data: ${payload}\n\n`);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (!hostAllowed(req.headers.host, this.opts.port)) {
      return send(res, 403, { error: "refused: Host header is not this machine (possible DNS rebinding)" });
    }
    if (!originAllowed(req.headers.origin, this.opts.port)) {
      return send(res, 403, { error: `refused: cross-origin request from ${req.headers.origin}` });
    }

    if (url.pathname === "/api/health") {
      const today = new Date(Date.now()).toISOString().slice(0, 10);
      const ext = externalPricing();
      return send(res, 200, {
        ok: this.lastError === null,
        error: this.lastError,
        actions: Boolean(this.opts.allowActions),
        sessions: this.latest?.totals.sessions ?? 0,
        otter: otterUrl(this.opts) ?? null,
        adapters: this.adapterStatus,
        sourcesPath: sourcesPath(),
        pricing: {
          path: pricingPath(),
          models: Object.keys(ext.models).length,
          verified: ext.verified ?? null,
          // Shown so a stale table is visible as stale rather than trusted.
          ageDays: stalenessDays(ext.verified, today),
          error: ext.error ?? null,
        },
      });
    }

    if (url.pathname === "/api/metrics") {
      if (!this.latest) return send(res, 503, { error: this.lastError ?? "no board yet" });
      return send(res, 200, computeMetrics(this.latest));
    }

    if (url.pathname === "/api/sessions") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return send(res, 200, listSessions({
        ...this.opts,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
        query: url.searchParams.get("q") ?? undefined,
      }));
    }

    const tasksFor = /^\/api\/session\/([^/]+)\/tasks$/.exec(url.pathname);
    if (tasksFor && req.method === "GET") {
      const list = readTasks(decodeURIComponent(tasksFor[1]!), this.opts);
      return send(res, 200, { ...list, counts: countTasks(list) });
    }

    if (url.pathname === "/api/board") {
      if (this.lastError) return send(res, 503, { error: this.lastError });
      return send(res, 200, this.latest);
    }

    if (url.pathname === "/api/events") return this.stream(req, res);

    const graph = /^\/api\/task\/([^/]+)\/graph$/.exec(url.pathname);
    if (graph) {
      const task = this.findTask(decodeURIComponent(graph[1]!));
      if (!task) return send(res, 404, { error: "no such task on the current board" });
      return send(res, 200, { spec: observedSpec(task), notes: notesFor(task) });
    }

    if (url.pathname.startsWith("/api/actions/")) return await this.action(url.pathname, req, res);

    if (url.pathname === "/api/pricing/reload") {
      reloadPricing();
      const ext = externalPricing();
      return send(res, 200, { models: Object.keys(ext.models).length, error: ext.error ?? null });
    }

    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "no such endpoint" });

    return this.static(url.pathname, res);
  }

  private findTask(id: string): Task | undefined {
    return this.latest?.tasks.find((t) => t.id === id);
  }

  private stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${JSON.stringify(this.latest ?? { error: this.lastError })}\n\n`);
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private async action(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return send(res, 405, { error: "actions are POST only" });
    if (!this.opts.allowActions) {
      return send(res, 403, {
        error:
          "actions are disabled. localflow watches by default and only steers when asked: " +
          "restart it with --allow-actions.",
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }

    const ctx: ActionContext = { allowedRoots: this.opts.allowedRoots, bin: this.opts.bin };
    const verb = pathname.slice("/api/actions/".length);
    const id = typeof body.sessionId === "string" ? body.sessionId : "";
    const task = id ? this.findTask(id) : undefined;

    switch (verb) {
      case "spawn":
        return send(res, 200, await spawnAgent(
          {
            prompt: String(body.prompt ?? ""),
            cwd: String(body.cwd ?? process.cwd()),
            model: optional(body.model),
            effort: optional(body.effort),
            agent: optional(body.agent),
          },
          ctx,
        ));

      case "reprompt": {
        if (!task) return send(res, 404, { error: "no such task on the current board" });
        // Answer before the turn finishes: a reprompt can run for minutes, and a
        // dashboard that blocks on it looks broken. Progress shows up on the board.
        send(res, 202, {
          ok: true,
          action: "reprompt",
          sessionId: id,
          detail: "turn started — watch the card for progress",
        });
        await reprompt(id, String(body.prompt ?? ""), { status: task.status, cwd: task.cwd }, ctx);
        return;
      }

      case "reroute": {
        if (!task) return send(res, 404, { error: "no such task on the current board" });
        send(res, 202, {
          ok: true,
          action: "reroute",
          sessionId: id,
          detail: "fork started — it appears as a new card",
        });
        await reroute(
          id,
          {
            model: optional(body.model),
            agent: optional(body.agent),
            effort: optional(body.effort),
            prompt: optional(body.prompt),
            cwd: task.cwd,
          },
          ctx,
        );
        return;
      }

      case "stop": {
        if (!task) return send(res, 404, { error: "no such task on the current board" });
        return send(res, 200, stopSession(task.pid, id));
      }

      // Writes into a session's own task list. Behind --allow-actions with the
      // rest, because it edits state a running agent reads from.
      case "task": {
        const result = createTask(
          {
            sessionId: String(body.sessionId ?? ""),
            subject: String(body.subject ?? ""),
            description: optional(body.description),
            activeForm: optional(body.activeForm),
          },
          this.opts,
        );
        return send(res, result.ok ? 200 : 400, { ...result, action: "task" });
      }

      case "task-status": {
        const result = setTaskStatus(
          String(body.sessionId ?? ""),
          String(body.taskId ?? ""),
          String(body.status ?? "") as TaskStatus,
          this.opts,
        );
        return send(res, result.ok ? 200 : 400, { ...result, action: "task-status" });
      }

      default:
        return send(res, 404, { error: `no such action: ${verb}` });
    }
  }

  private static(pathname: string, res: ServerResponse): void {
    const root = this.opts.webRoot ?? defaultWebRoot();
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    // normalize + prefix check: a request for `/../../etc/passwd` resolves out
    // of the web root, and this is where that stops.
    const target = resolvePath(join(root, normalize(rel)));
    if (!target.startsWith(resolvePath(root))) return send(res, 403, { error: "refused" });
    if (!existsSync(target) || !statSync(target).isFile()) {
      return send(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      // The UI loads nothing from anywhere else, so say so.
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'",
      "x-content-type-options": "nosniff",
    });
    createReadStream(target).pipe(res);
  }
}

function optional(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body ?? null);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("body is not an object");
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`could not read the request body: ${(e as Error).message}`);
  }
}

export function defaultWebRoot(): string {
  // dist/src/server.js -> dist/web
  return resolvePath(new URL("../web", import.meta.url).pathname);
}
