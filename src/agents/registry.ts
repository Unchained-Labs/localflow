/**
 * Which readers are wired up, and what each one had to say.
 *
 * The registry polls every adapter concurrently and merges the results. One
 * adapter failing must not empty the board — that was the point of splitting
 * them apart — so a rejected poll becomes a `degraded` entry naming the
 * adapter, and every other card still renders.
 *
 * Absence and failure are kept apart all the way to the UI. A machine with no
 * Codex on it should show nothing about Codex; a machine with Codex installed
 * and unreadable should say so, once, with the path that failed.
 */
import { DeclaredSourceAdapter, loadSources } from "./jsonl.js";
import type { SourceSpec } from "./jsonl.js";
import type { AdapterContext, AdapterResult, AgentAdapter, Probe } from "./types.js";

export interface AdapterStatus {
  id: string;
  label: string;
  probe: Probe;
  /** Cards this adapter contributed on the last poll. */
  tasks: number;
}

export interface RegistryResult extends AdapterResult {
  adapters: AdapterStatus[];
}

export class AdapterRegistry {
  private readonly adapters: AgentAdapter[] = [];

  add(adapter: AgentAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  /** Wire up every source declared in ~/.localflow/sources.json. */
  addDeclared(path?: string): { count: number; error?: string } {
    const { sources, error } = loadSources(path);
    for (const spec of sources) this.add(new DeclaredSourceAdapter(spec));
    return { count: sources.length, error };
  }

  get ids(): string[] {
    return this.adapters.map((a) => a.id);
  }

  async poll(ctx: AdapterContext): Promise<RegistryResult> {
    const results = await Promise.all(
      this.adapters.map(async (adapter): Promise<AdapterStatus & { result: AdapterResult }> => {
        let probe: Probe;
        try {
          probe = await adapter.probe();
        } catch (e) {
          probe = { ok: false, absent: false, detail: `probe failed: ${(e as Error).message}` };
        }
        if (!probe.ok) {
          return { id: adapter.id, label: adapter.label, probe, tasks: 0, result: { tasks: [], degraded: [] } };
        }
        try {
          const result = await adapter.poll(ctx);
          return { id: adapter.id, label: adapter.label, probe, tasks: result.tasks.length, result };
        } catch (e) {
          return {
            id: adapter.id,
            label: adapter.label,
            probe: { ok: false, absent: false, detail: `poll failed: ${(e as Error).message}` },
            tasks: 0,
            result: { tasks: [], degraded: [] },
          };
        }
      }),
    );

    const tasks = results.flatMap((r) => r.result.tasks);
    const degraded = results.flatMap((r) => r.result.degraded);
    for (const r of results) {
      // A broken adapter is worth one line on the board. An absent one is worth
      // none: it is not a problem, it is a tool this machine does not have.
      if (!r.probe.ok && !r.probe.absent) degraded.push({ id: r.id, reason: r.probe.detail });
    }

    return {
      tasks,
      degraded,
      adapters: results.map(({ id, label, probe, tasks: n }) => ({ id, label, probe, tasks: n })),
    };
  }
}

/** The templates shipped for tools this repo cannot verify. See docs/sources.md. */
export const SOURCE_TEMPLATES: Record<string, Omit<SourceSpec, "id">> = {
  codex: { label: "Codex CLI", root: "~/.codex/sessions", match: "\\.jsonl$" },
  gemini: { label: "Gemini CLI", root: "~/.gemini/tmp", match: "\\.json$" },
  aider: { label: "Aider", root: "~/.aider", match: "\\.jsonl$" },
  opencode: { label: "OpenCode", root: "~/.local/share/opencode", match: "\\.jsonl$" },
};
