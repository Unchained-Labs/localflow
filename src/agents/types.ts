/**
 * The seam between "an agent ran" and "the board knows about it".
 *
 * localflow started as a Claude Code board, and the Claude reader grew into the
 * shape every other tool needs too: find the sessions, read whatever each one
 * left on disk, produce cards. `src/otter.ts` was the second implementation of
 * that shape and shares no code with the first, which is the usual sign that
 * the shape should have been an interface one implementation earlier.
 *
 * So here it is. An adapter answers two questions:
 *
 *   1. **Is your tool even here?** — `probe()`. A tool that is not installed is
 *      not a failure and must not appear as one; a tool that IS installed but
 *      unreadable is a failure and must say why. These are different answers and
 *      the board renders them differently.
 *   2. **What is running?** — `poll()`. Cards, plus anything that went wrong
 *      while producing them.
 *
 * The rule an adapter must not break: **never invent a number**. If a tool does
 * not record token counts, report zero usage and `costUsd: null` — not a
 * guess, and never `0`, which reads as "this was free" rather than "we do not
 * know". The board is only worth reading if the gaps in it are visible.
 */
import type { Task } from "../types.js";

/** Whether an adapter can do its job on this machine, and why not if it cannot. */
export interface Probe {
  /** The tool is installed and its state is readable. */
  ok: boolean;
  /**
   * True when the tool simply is not on this machine. Absence is not an error:
   * a board that shows five red "Codex unavailable" banners on a machine with
   * no Codex has taught its reader to ignore banners.
   */
  absent: boolean;
  /** One line a human can act on. Empty when `ok`. */
  detail: string;
}

export interface AdapterResult {
  tasks: Task[];
  /** Sessions the adapter knew about but could not enrich, and why. */
  degraded: { id: string; reason: string }[];
}

export interface AdapterContext {
  /** Date used for intro-price expiry. Defaults to today. */
  asOf?: string;
  /** How many ended sessions to include. 0 means live only. */
  history?: number;
}

export interface AgentAdapter {
  /** Stable id, used as the `source` on every card it produces. */
  readonly id: string;
  /** What to call it on screen. */
  readonly label: string;
  /**
   * Which vendor's prices apply to the models this adapter reports. Adapters
   * that see several vendors (a proxy, a gateway) return undefined and let the
   * model id decide.
   */
  readonly provider?: string;

  probe(): Promise<Probe>;
  poll(ctx: AdapterContext): Promise<AdapterResult>;
}

/** An adapter that is present but produced nothing — the common, boring case. */
export const NOTHING: AdapterResult = { tasks: [], degraded: [] };

export function absent(detail: string): Probe {
  return { ok: false, absent: true, detail };
}

export function broken(detail: string): Probe {
  return { ok: false, absent: false, detail };
}

export const PRESENT: Probe = { ok: true, absent: false, detail: "" };
