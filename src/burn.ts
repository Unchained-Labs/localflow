/**
 * How fast the money is going, and which five-hour block it is going into.
 *
 * The board already knows what every session cost. What it could not answer is
 * the question anyone watching agents run actually asks — *am I about to run
 * out?* — which needs two things this file derives and nothing else here does:
 * a rate over a recent window, and the position of the current usage block.
 *
 * **The block is not our unit; it is Anthropic's.** Usage limits reset on
 * rolling five-hour windows, so "spent today" is the wrong denominator and
 * "spent this block" is the right one. A block opens with the first session
 * after the previous one closed, and its start is floored to the hour — that
 * flooring is upstream behaviour, not a rounding convenience, and it is why
 * this file cannot simply cut the timeline into fixed five-hour slabs. Two
 * sessions at 09:30 and 12:30 are one block starting 09:00; slab arithmetic
 * (`floor(t / 5h) * 5h`) puts them in two, and everything downstream — spend so
 * far, time remaining, the projection — is then wrong in a way that still looks
 * like a plausible dashboard.
 *
 * Three rules, all inherited from how this repo already treats cost:
 *
 *   * **A rate over a sample we do not have is not stated.** Extrapolation is
 *     the entire value of a burn rate and also its entire failure mode. Every
 *     figure here carries how much of its window the board could actually see,
 *     and refuses outright — null, not zero — when that is nothing.
 *   * **Unpriced work makes a spend figure a floor, never a total.** A window
 *     in which nothing could be priced has no money rate at all: reporting
 *     `$0.00/h` for an hour of unpriced work is the confident under-report this
 *     dashboard exists not to produce. The token rate still stands, because
 *     token counts are measured rather than looked up.
 *   * **The board is the sample.** Ended sessions age off the board (`--history`),
 *     so a 24-hour rate computed from a trimmed board is a floor for the same
 *     reason an unpriced session is. Said once, in the note that travels with
 *     the number.
 *   * **A session's cost lands where its last activity did.** That is all the
 *     board knows: a card carries one cumulative total and one timestamp, not a
 *     spend curve. So a nine-hour session pays for itself entirely inside
 *     whichever window it last touched, and a rate over that window is bunched
 *     rather than spread. Nothing here can fix that without per-message
 *     timestamps the cards do not carry — so it is counted and said out loud
 *     instead, which is the difference between an approximation and a lie.
 */
import { addUsage, totalTokens, zeroUsage } from "./types.js";
import type { Task, Usage } from "./types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The rolling window Anthropic meters usage in. Not ours to pick. */
export const BLOCK_MS = 5 * HOUR;

/** Windows the burn rate is reported over: one for "right now", one for "lately". */
export const BURN_WINDOWS = [HOUR, 24 * HOUR] as const;

/**
 * Below this share of a window, a rate is still shown but flagged.
 *
 * Shown because "$3 in the four minutes since this board started" is real
 * information; flagged because multiplying it by fifteen is not.
 */
const THIN_SAMPLE = 0.25;

/**
 * A block has to be this far along before we will project its end.
 *
 * A quarter-hour of a five-hour block. Lower and the projection is a rounding
 * error times twenty; the reason it is a hard refusal rather than another flag
 * is that this figure is a claim about the future, and a claim about the future
 * from ninety seconds of evidence should not be made at all.
 */
const MIN_PROJECTION_MS = 15 * MINUTE;

/** A rolling window, and everything needed to read its rates honestly. */
export interface BurnWindow {
  /** Nominal width, ms. */
  windowMs: number;
  from: number;
  to: number;
  sessions: number;
  usage: Usage;
  /**
   * Spend observed inside the window. A floor whenever `unpriced` is non-zero,
   * and null — never 0 — when the window held sessions and none could be priced.
   */
  costUsd: number | null;
  /** Sessions in the window whose model has no known price. */
  unpriced: number;
  /**
   * Sessions counted here that began before the window did.
   *
   * Their whole cost is inside this window because their last activity is, and
   * most of the work behind it is not. The rate is still the best statement of
   * "what has this window been billed", but it is bunched, and a reader who
   * cannot see that will read it as a steady state.
   */
  straddling: number;
  /**
   * How much of the window the board could actually see, ms.
   *
   * The denominator every rate below divides by. It is the window width once
   * the board has been watching longer than the window, and less than that on a
   * board that has only just started — which is exactly when a naive rate
   * turns three minutes of work into a daily figure.
   */
  sampleMs: number;
  /** Dollars per hour. Null when there is no sample, or nothing here is priced. */
  costPerHour: number | null;
  /** Tokens per hour. Survives unpriced sessions — token counts are measured. */
  tokensPerHour: number | null;
  /** `costPerHour` omits work that happened. It is a lower bound. */
  costIsFloor: boolean;
  /** The sample covers less than a quarter of the window. */
  thin: boolean;
  /** Every caveat above, in prose, ready to render verbatim. Empty when there is none. */
  note: string;
}

/** One five-hour usage block, in progress or already closed. */
export interface Block {
  /** First session in the block, floored to the hour — upstream's rule, not ours. */
  startedAt: number;
  /** `startedAt + 5h`. Exclusive: a session landing exactly here opens the next block. */
  endsAt: number;
  /** True while `now` is inside this block. At most one block is. */
  active: boolean;
  sessions: number;
  usage: Usage;
  /** Spend in the block. A floor when some sessions are unpriced, null when all are. */
  costUsd: number | null;
  unpriced: number;
  /** Sessions whose work began before this block opened. See `BurnWindow.straddling`. */
  straddling: number;
  costIsFloor: boolean;
  /** ms until the limit resets. Zero for a block already closed. */
  remainingMs: number;
  /** Spend by `endsAt` if the block keeps going as it has. Null when we will not guess. */
  projectedCostUsd: number | null;
  projectedTokens: number | null;
  /** Why the figures above read the way they do. Empty when there is nothing to say. */
  note: string;
}

/**
 * When a task happened.
 *
 * A task with no timestamp at all is dropped rather than placed at `now`, which
 * is what the bucketing in `metrics.ts` does with it. The two want different
 * things: a bar chart of a stampless session has to draw it somewhere, and a
 * rate does not — counting it as "just now" would make the live burn rate jump
 * for work that may be days old.
 */
function stampOf(t: Task): number {
  return t.updatedAt || t.startedAt;
}

/** Durations the way a person says them. */
function humanMs(ms: number): string {
  if (ms < MINUTE) return "under a minute";
  const m = Math.round(ms / MINUTE);
  if (m < 90) return `${m} min`;
  const h = ms / HOUR;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`;
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** The rate over one window. Exported for tests; the board gets it via `burnRates`. */
export function burnOver(tasks: Task[], windowMs: number, now: number): BurnWindow {
  const from = now - windowMs;
  // Coverage runs from the earliest evidence of *any* activity, which means
  // start times count too: a session that began nine hours ago and last moved a
  // minute ago proves the board has been watching for nine hours. Taking only
  // last-activity stamps would call that a one-minute sample and multiply its
  // spend by sixty.
  const stamps = tasks.flatMap((t) => [t.startedAt, stampOf(t)]).filter((at) => at > 0);
  // Nothing on the board means nothing observed, not a quiet hour. `now` here
  // yields a zero-length sample, which is how the rates below come back null.
  const earliest = stamps.length ? Math.min(...stamps) : now;
  const sampleMs = Math.max(0, Math.min(windowMs, now - earliest));

  const usage = zeroUsage();
  let sessions = 0;
  let costUsd = 0;
  let unpriced = 0;
  let straddling = 0;
  for (const t of tasks) {
    const at = stampOf(t);
    // No upper bound on purpose: a stamp a second past `now` is clock skew, not
    // a session from tomorrow, and excluding it would make the live rate blink.
    if (at <= 0 || at < from) continue;
    sessions++;
    if (t.startedAt > 0 && t.startedAt < from) straddling++;
    addUsage(usage, t.usage);
    if (t.costUsd === null) unpriced++;
    else costUsd += t.costUsd;
  }

  const hours = sampleMs / HOUR;
  const nothingPriced = sessions > 0 && unpriced === sessions;
  const costPerHour = hours <= 0 || nothingPriced ? null : costUsd / hours;
  // An empty window really did cost nothing; a window nobody could price did
  // not. Only the second one is unknown, and only it gets a null.
  const spend = nothingPriced ? null : costUsd;
  const tokensPerHour = hours <= 0 ? null : totalTokens(usage) / hours;
  const costIsFloor = costPerHour !== null && unpriced > 0;
  const thin = hours > 0 && sampleMs < windowMs * THIN_SAMPLE;

  const notes: string[] = [];
  if (hours <= 0) {
    notes.push("Nothing observed yet, so there is no rate to state.");
  } else {
    if (nothingPriced) {
      notes.push(
        `No price is known for any of the ${sessions} session${plural(sessions)} in this window, ` +
          "so there is no spend rate — only a token rate.",
      );
    } else if (costIsFloor) {
      notes.push(
        `${unpriced} of ${sessions} session${plural(sessions)} here could not be priced, ` +
          "so this is a floor, not a total.",
      );
    }
    if (thin) {
      notes.push(
        `The board has only seen ${humanMs(sampleMs)} of this window, ` +
          "so the rate is scaled up from a short sample.",
      );
    }
    if (straddling) {
      notes.push(
        `${straddling} session${plural(straddling)} here started before the window did, ` +
          "and a session is billed to its last activity — so this rate is bunched rather than spread.",
      );
    }
  }

  return {
    windowMs,
    from,
    to: now,
    sessions,
    usage,
    costUsd: spend,
    unpriced,
    straddling,
    sampleMs,
    costPerHour,
    tokensPerHour,
    costIsFloor,
    thin,
    note: notes.join(" "),
  };
}

/** The rate over each of `BURN_WINDOWS`, narrowest first. */
export function burnRates(tasks: Task[], now: number): BurnWindow[] {
  return BURN_WINDOWS.map((w) => burnOver(tasks, w, now));
}

/**
 * Cut the board into five-hour usage blocks, oldest first.
 *
 * A block ends five hours after its floored start, and the next session after
 * that opens a new one. There is deliberately no separate "five hours of
 * inactivity" rule: a session more than five hours after the previous one is
 * necessarily past that block's end, because the block started at or before
 * that previous session. One rule, and it already covers the other.
 *
 * `limit` keeps the returned list to the most recent blocks, so a board holding
 * a year of history does not hand the chart 1,700 bars.
 */
export function blocksOf(tasks: Task[], now: number, limit = 24): Block[] {
  const stamped = tasks
    .map((t) => ({ t, at: stampOf(t) }))
    .filter((x) => x.at > 0)
    .sort((a, b) => a.at - b.at);

  const blocks: Block[] = [];
  let open: Block | undefined;
  for (const { t, at } of stamped) {
    if (!open || at >= open.endsAt) {
      // Floored to the UTC hour, which is what the limits themselves do. In a
      // zone offset by whole hours this is also the local hour; in one offset by
      // thirty minutes it is not, and following upstream matters more than
      // matching a wall clock.
      const startedAt = Math.floor(at / HOUR) * HOUR;
      open = {
        startedAt,
        endsAt: startedAt + BLOCK_MS,
        active: false,
        sessions: 0,
        usage: zeroUsage(),
        costUsd: 0,
        unpriced: 0,
        straddling: 0,
        costIsFloor: false,
        remainingMs: 0,
        projectedCostUsd: null,
        projectedTokens: null,
        note: "",
      };
      blocks.push(open);
    }
    open.sessions++;
    if (t.startedAt > 0 && t.startedAt < open.startedAt) open.straddling++;
    addUsage(open.usage, t.usage);
    if (t.costUsd === null) open.unpriced++;
    // Null is a verdict the finalising pass below reaches, not a state this
    // loop can be in: while accumulating, a block has counted 0 or more dollars.
    else open.costUsd = (open.costUsd ?? 0) + t.costUsd;
  }

  for (const b of blocks) {
    const nothingPriced = b.sessions > 0 && b.unpriced === b.sessions;
    b.costIsFloor = b.unpriced > 0 && !nothingPriced;
    if (nothingPriced) b.costUsd = null;
    b.active = now >= b.startedAt && now < b.endsAt;
    if (!b.active) continue;

    b.remainingMs = b.endsAt - now;
    // Elapsed is measured from the block's start, not from its first session:
    // the limit resets on the block clock, so that is the clock the projection
    // has to run on even when the first session arrived forty minutes into it.
    const elapsed = now - b.startedAt;
    const notes: string[] = [];
    if (elapsed < MIN_PROJECTION_MS) {
      notes.push(
        `Only ${humanMs(elapsed)} into the block — too little to project the rest of it from.`,
      );
    } else {
      b.projectedTokens = (totalTokens(b.usage) * BLOCK_MS) / elapsed;
      if (b.costUsd !== null) b.projectedCostUsd = (b.costUsd * BLOCK_MS) / elapsed;
    }
    if (nothingPriced) {
      notes.push(
        `No price is known for any of the ${b.sessions} session${plural(b.sessions)} in this block, ` +
          "so there is no spend to report or project.",
      );
    } else if (b.costIsFloor) {
      notes.push(
        `${b.unpriced} of ${b.sessions} session${plural(b.sessions)} in this block could not be priced, ` +
          "so the spend and the projection are both floors.",
      );
    }
    if (b.straddling) {
      notes.push(
        `${b.straddling} session${plural(b.straddling)} began before this block opened and is billed ` +
          "to its last activity, so some of the spend above was earned under the previous limit window.",
      );
    }
    b.note = notes.join(" ");
  }

  return blocks.slice(-limit);
}
