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
import { NO_VERDICTS, estimateGap, estimateObserved, lensPlan, lintObserved } from "./family.js";
import {
  budgetGate,
  familySpec,
  lintGate,
  listWorkflows,
  readWorkflow,
  runWorkflow,
  saveWorkflow,
  validate as validateWorkflow,
  workflowsDir,
} from "./workflow.js";
import type { RunEvent, RunState, WorkflowSpec } from "./workflow.js";
import { otterTasks, otterUrl } from "./otter.js";
import { summarise } from "./board.js";
import { AdapterRegistry } from "./agents/registry.js";
import type { AdapterStatus } from "./agents/registry.js";
import { computeMetrics } from "./metrics.js";
import { waterFor } from "./water.js";
import { externalPricing, reloadPricing } from "./pricing.js";
import { pricingPath, stalenessDays } from "./providers.js";
import { sourcesPath } from "./agents/jsonl.js";
import { findDevice, loadDevices, devicesPath } from "./devices.js";
import { killSession, listSessions as listRemoteSessions, probeDevice, startSession } from "./remote.js";
import { Fleet, mirrorRoot } from "./mirror.js";
import type { DevicePoll } from "./mirror.js";
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
  /**
   * Enables the remote-device routes. Deliberately separate from allowActions:
   * "you may restart something on this box" and "you may start a process on a
   * different computer" are not the same permission, and folding the second
   * into the first would grant it to everyone who wanted the first.
   */
  allowRemote?: boolean;
  /**
   * Read the sessions on every monitored device and show them on the board.
   *
   * Deliberately not folded into allowRemote. Starting a process on another
   * machine and copying that machine's transcripts onto this disk are different
   * things to consent to, and either without the other is a reasonable thing to
   * want: a build box you fire work at but do not want mirrored, or a fleet you
   * only ever watch. Both default off.
   */
  watchRemote?: boolean;
  /** How often devices are polled. Much slower than the local loop: ssh is not a readSync. */
  remotePollMs?: number;
  /**
   * The port the browser will name in `Host`, when that is not the port we
   * listen on — a container published as `7400:7317`, or a reverse proxy.
   *
   * The Host check deliberately refuses the right machine on the wrong port,
   * and that stays true; this only says which port is the right one. Defaults
   * to the listen port, so a direct run is unchanged.
   */
  publicPort?: number;
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

  /**
   * Runs this process started, newest last.
   *
   * In memory: a run is a live thing with a stream attached, and it belongs to
   * the process that is doing it. The sessions it creates are on disk like any
   * others, so what survives a restart is the work rather than the bookkeeping.
   */
  private readonly runs = new Map<string, RunState>();

  /** Listeners on /api/workflows/runs/events, one per open canvas. */
  private readonly runWatchers = new Set<ServerResponse>();
  private adapterStatus: AdapterStatus[] = [];
  private sourcesError: string | undefined;

  /**
   * The monitored machines.
   *
   * Polled on its own timer rather than inside the board loop, because one
   * device behind a `ConnectTimeout` would otherwise stall every local card
   * for eight seconds. The board merges whatever the last device poll left
   * here, which may be a few seconds old and says so.
   */
  private readonly fleet: Fleet;
  private devicePolls: DevicePoll[] = [];
  private fleetTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private http: Server | null = null;

  constructor(opts: ServerOptions = {}) {
    this.opts = { port: 7317, host: "127.0.0.1", pollMs: 2_000, ...opts };
    this.board = new Board(opts);
    // Declared sources are read once at construction. Editing sources.json is
    // a restart, which is the right cost for a file that changes about as often
    // as you install a new agent CLI.
    this.sourcesError = this.registry.addDeclared().error;
    this.fleet = new Fleet({ history: opts.history, asOf: opts.asOf });
  }

  async start(): Promise<{ url: string }> {
    if (this.opts.watchRemote) await this.pollFleet();
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.pollMs);
    this.timer.unref?.();

    if (this.opts.watchRemote) {
      const every = this.opts.remotePollMs ?? 10_000;
      this.fleetTimer = setInterval(() => void this.pollFleet(), every);
      this.fleetTimer.unref?.();
    }

    this.http = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.http!.listen(this.opts.port, this.opts.host, r));
    return { url: `http://${this.opts.host}:${this.opts.port}/` };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.fleetTimer) clearInterval(this.fleetTimer);
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  /** The current board, for tests and for the CLI's one-shot mode. */
  get snapshot(): BoardSummary | null {
    return this.latest;
  }

  /**
   * One pass over the monitored devices.
   *
   * devices.json is re-read every pass, so adding a machine is an edit rather
   * than a restart -- the opposite call from sources.json, because a fleet
   * changes when someone opens a laptop and an installed CLI does not.
   *
   * Never throws: an unreachable device is the normal case, and it comes back
   * as a card marked stale rather than as an exception that would take the
   * local board down with it.
   */
  private async pollFleet(): Promise<void> {
    try {
      const { devices } = loadDevices();
      this.fleet.sync(devices);
      this.devicePolls = await this.fleet.poll();
    } catch (e) {
      this.devicePolls = [];
      this.lastError = `device poll failed: ${(e as Error).message}`;
    }
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
      // Whatever the last device poll produced. Merged exactly like Otter and
      // the declared adapters: a card from another machine is a card.
      if (this.opts.watchRemote && this.devicePolls.length) {
        const remoteTasks = this.devicePolls.flatMap((p) => p.tasks);
        for (const p of this.devicePolls) summary.degraded.push(...p.degraded);
        if (remoteTasks.length) {
          Object.assign(
            summary,
            summarise([...summary.tasks, ...remoteTasks], summary.degraded, this.opts.asOf),
          );
        }
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

    const expectedPort = this.opts.publicPort ?? this.opts.port;
    if (!hostAllowed(req.headers.host, expectedPort)) {
      return send(res, 403, { error: "refused: Host header is not this machine (possible DNS rebinding)" });
    }
    if (!originAllowed(req.headers.origin, expectedPort)) {
      return send(res, 403, { error: `refused: cross-origin request from ${req.headers.origin}` });
    }

    if (url.pathname === "/api/health") {
      const today = new Date(Date.now()).toISOString().slice(0, 10);
      const ext = externalPricing();
      return send(res, 200, {
        ok: this.lastError === null,
        error: this.lastError,
        actions: Boolean(this.opts.allowActions),
        remote: Boolean(this.opts.allowRemote),
        watchRemote: Boolean(this.opts.watchRemote),
        devicesPath: devicesPath(),
        // Named because it holds other machines' prompts. A copy you cannot
        // find is a copy you cannot delete.
        mirrorPath: this.opts.watchRemote ? mirrorRoot() : null,
        devices: this.devicePolls.map((p) => ({
          name: p.device,
          reachable: p.reachable,
          error: p.error,
          syncedAt: p.syncedAt,
          staleSince: p.staleSince,
          cards: p.tasks.length,
        })),
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
      const metrics = computeMetrics(this.latest);
      // Water comes from soif, one subprocess per model. On-demand rather than
      // in the poll loop: nobody needs it refreshed every two seconds, and the
      // board must not slow down for a panel that is not on screen.
      const water = await waterFor(
        metrics.byModel.map((m) => ({
          model: m.key,
          input: m.usage.input,
          output: m.usage.output,
          cached: m.usage.cacheRead,
        })),
      );
      return send(res, 200, { ...metrics, water });
    }

    if (url.pathname === "/api/devices") return await this.devices(res);

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

    // graphlint and preflight, run against that same graph. Separate from
    // /graph and fetched on demand, because these are two subprocesses: the
    // drawer must open at the speed of a local read whether or not the rest of
    // the family is installed.
    const review = /^\/api\/task\/([^/]+)\/review$/.exec(url.pathname);
    if (review) {
      const task = this.findTask(decodeURIComponent(review[1]!));
      if (!task) return send(res, 404, { error: "no such task on the current board" });
      const spec = observedSpec(task);
      const [lint, estimate] = await Promise.all([lintObserved(spec), estimateObserved(spec)]);

      // The lens plan is only fetched when something actually caught a panel of
      // verifiers asking one question — either this board's own note or
      // graphlint's rule. Offering the fix beside a problem nobody has is how a
      // panel becomes furniture.
      const correlated =
        notesFor(task).some((n) => n.rule === "correlated-verifiers") ||
        lint.findings.some((f) => f.rule === "correlated-verifiers");

      return send(res, 200, {
        lint,
        estimate,
        gap: estimateGap(task.costUsd, estimate),
        lenses: correlated ? await lensPlan() : null,
        // Said even when the plan is there: the plan is the fix, and the reason
        // localflow cannot measure the problem itself is a separate fact.
        noVerdicts: correlated ? NO_VERDICTS : null,
      });
    }

    // ---- workflows -------------------------------------------------------
    //
    // Reading is always allowed; running is not. Composing a graph is editing a
    // file, and starting one is starting a fleet of sessions, so the second
    // sits behind --allow-actions with every other verb that spends money.

    if (url.pathname === "/api/workflows") {
      return send(res, 200, { workflows: listWorkflows(), dir: workflowsDir() });
    }

    if (url.pathname === "/api/workflows/runs") {
      return send(res, 200, { runs: [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt) });
    }

    if (url.pathname === "/api/workflows/runs/events") return this.streamRuns(req, res);

    const wf = /^\/api\/workflows\/([^/]+)$/.exec(url.pathname);
    if (wf && req.method === "GET") {
      const spec = readWorkflow(decodeURIComponent(wf[1]!));
      if (!spec) return send(res, 404, { error: "no such workflow" });
      return send(res, 200, { spec, problems: validateWorkflow(spec, this.actionCtx()) });
    }

    if (url.pathname.startsWith("/api/workflows/")) {
      return await this.workflowAction(url.pathname, req, res);
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

  /** The context every action and workflow is held to. */
  private actionCtx(): ActionContext {
    return { allowedRoots: this.opts.allowedRoots, bin: this.opts.bin };
  }

  /**
   * Run progress, as it happens.
   *
   * The board already streams; this is a second, much quieter stream carrying
   * only node state changes, so a canvas can light up without re-polling a run
   * that may be spending money for twenty minutes.
   */
  private streamRuns(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": open\n\n");
    this.runWatchers.add(res);
    req.on("close", () => this.runWatchers.delete(res));
  }

  private publishRun(e: RunEvent): void {
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const w of this.runWatchers) {
      try {
        w.write(frame);
      } catch {
        this.runWatchers.delete(w);
      }
    }
  }

  /** Save, validate, estimate, run. Everything that changes or spends. */
  private async workflowAction(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/api\/workflows\/([^/]+)\/([a-z]+)$/.exec(pathname);
    const rest = pathname.slice("/api/workflows/".length);

    let body: Record<string, unknown> = {};
    if (req.method === "POST" || req.method === "PUT") {
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }

    // PUT /api/workflows/<name> — save.
    if (!m && req.method === "PUT") {
      const spec = body as unknown as WorkflowSpec;
      if (spec?.name !== decodeURIComponent(rest)) {
        return send(res, 400, { error: "the workflow's name and the path must agree" });
      }
      const problems = validateWorkflow(spec, this.actionCtx());
      // Saved even when it does not validate: a draft you cannot save is a
      // draft you lose. Running is where the problems become refusals.
      const saved = saveWorkflow(spec);
      return send(res, saved.ok ? 200 : 400, { ...saved, problems });
    }

    if (!m) return send(res, 404, { error: "no such endpoint" });

    const name = decodeURIComponent(m[1]!);
    const verb = m[2];
    const spec = readWorkflow(name);
    if (!spec) return send(res, 404, { error: "no such workflow" });

    if (verb === "check") {
      // What the family says, before a token is spent. Both gates report what
      // they decided even when they let it past.
      const [problems, lint, budget] = await Promise.all([
        Promise.resolve(validateWorkflow(spec, this.actionCtx())),
        lintGate(spec),
        budgetGate(spec),
      ]);
      return send(res, 200, { problems, lint, budget, spec: familySpec(spec) });
    }

    if (verb === "run") {
      if (!this.opts.allowActions) {
        return send(res, 403, {
          error:
            "running a workflow starts Claude Code sessions, and actions are off. " +
            "Restart localflow with --allow-actions.",
        });
      }
      const runId = `run-${Date.now().toString(36)}`;
      // Answer immediately and let it run: a workflow is minutes of work, and
      // an HTTP request held open for it would time out somewhere in between.
      void runWorkflow(spec, {
        ...this.actionCtx(),
        runId,
        force: body.force === true,
        maxConcurrent: typeof body.maxConcurrent === "number" ? body.maxConcurrent : undefined,
        onEvent: (e) => {
          if (e.type === "run") this.runs.set(e.run.id, e.run);
          this.publishRun(e);
        },
      }).then((final) => this.runs.set(final.id, final));
      return send(res, 202, { runId, detail: "started; watch /api/workflows/runs/events" });
    }

    return send(res, 404, { error: "no such endpoint" });
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

    // Every verb below resumes or signals a process on *this* machine. A card
    // from a watched device names a session that is not here, and `claude
    // --resume studio:abc` would either fail confusingly or, worse, match a
    // local session that happened to share the id. Refusing by name is the
    // honest answer, and it names what would be needed instead.
    if (task?.device && verb !== "spawn") {
      return send(res, 409, {
        error:
          `${task.remoteId ?? id} is running on ${task.device}, not on this machine. ` +
          "localflow watches a device read-only; steering a session there means doing it there.",
      });
    }

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

      case "remote-start":
      case "remote-kill": {
        if (!this.opts.allowRemote) {
          return send(res, 403, {
            error:
              "remote devices are disabled. Starting a process on another machine is a " +
              "separate decision from steering this one: restart with --allow-remote.",
          });
        }
        const { devices, error } = loadDevices();
        if (error) return send(res, 400, { error });
        // The device is resolved from the registry by name. The request never
        // supplies a host, so an unknown name is simply not a device.
        const device = findDevice(devices, body.device);
        if (!device) {
          return send(res, 404, {
            error: `no device named ${JSON.stringify(body.device ?? null)} in ${devicesPath()}`,
          });
        }

        if (verb === "remote-kill") {
          const out = await killSession(device, String(body.session ?? ""));
          return send(res, out.ok ? 200 : 400, out.ok ? { ok: true } : { error: out.error });
        }

        const out = await startSession(device, {
          name: String(body.name ?? ""),
          prompt: String(body.prompt ?? ""),
          cwd: optional(body.cwd),
        });
        return send(res, out.ok ? 200 : 400, out.ok ? out.value : { error: out.error });
      }

      default:
        return send(res, 404, { error: `no such action: ${verb}` });
    }
  }

  /**
   * Every declared device, each with what it could tell us about itself.
   *
   * Probed concurrently and never fatally: a laptop that is asleep is the normal
   * case, not an error, and one unreachable machine must not empty the panel.
   *
   * The tmux probe only runs when starting work is actually permitted. It costs
   * a round trip per device and answers a question -- "could I launch here?" --
   * that a board in watch-only mode has no business asking.
   */
  private async devices(res: ServerResponse): Promise<void> {
    const canStart = Boolean(this.opts.allowRemote);
    const watching = Boolean(this.opts.watchRemote);
    if (!canStart && !watching) {
      return send(res, 200, { enabled: false, canStart: false, watching: false, devices: [], path: devicesPath() });
    }
    const { devices, error } = loadDevices();
    const polls = new Map(this.devicePolls.map((p) => [p.device, p]));

    const rows = await Promise.all(
      devices.map(async (d) => {
        const poll = polls.get(d.name);
        const [probe, sessions] = canStart
          ? await Promise.all([probeDevice(d), listRemoteSessions(d)])
          : [undefined, undefined];

        // Reachability, in descending order of how recently it was established.
        // A device we are watching has been reached within a poll interval; one
        // we only spawn on has just been probed; a device that is neither has
        // told us nothing, and `null` says so rather than guessing "off".
        const reachable = probe ? probe.ok : (poll?.reachable ?? null);
        return {
          name: d.name,
          host: d.host,
          reachable,
          detail: probe && !probe.ok ? (probe.error ?? "unreachable") : (poll?.error ?? ""),
          tmux: probe?.value?.tmux ?? false,
          claude: probe?.value?.bin ?? false,
          sessions: sessions?.value ?? [],
          // Monitoring, which is a different question from "can I start work here".
          monitored: watching && d.monitor !== false,
          cards: poll?.tasks.length ?? 0,
          syncedAt: poll?.syncedAt ?? null,
          staleSince: poll?.staleSince ?? null,
        };
      }),
    );
    return send(res, 200, {
      enabled: true,
      canStart,
      watching,
      devices: rows,
      path: devicesPath(),
      mirror: watching ? mirrorRoot() : null,
      error: error ?? null,
    });
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
