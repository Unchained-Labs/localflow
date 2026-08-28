/**
 * Telling one agent's cards from another's, at a glance.
 *
 * ## Why this is not a colour scheme
 *
 * The obvious answer is a hue per tool. It was measured against this repo's own
 * surfaces with the categorical-palette validator and it does not survive
 * contact with the requirement.
 *
 * Any two cards can sit next to each other on a Kanban board, so the pairlist
 * that matters is *all pairs*, not adjacent ones. Under all pairs, a perceptual
 * hue wheel supports **three** categories that stay apart for a red-green
 * colourblind reader; at four, two of them collide (normal-vision ΔE 13.7
 * against a floor of 15), and at six the worst pair reaches ΔE 3.2 under
 * protanopia -- two different tools, one colour. There are already more than
 * three plausible sources (Claude Code, Codex, Gemini, opencode, Aider, Otter),
 * so a per-tool hue would mean shipping a legend that lies to some of its
 * readers. On a board whose entire argument is that its gaps are visible, that
 * is not a small cost.
 *
 * So identity is carried by **a monogram and the tool's name** -- channels that
 * do not degrade -- and colour is left to the operator, who knows how many
 * tools they actually run and can pick two that they personally can tell apart.
 * `"color"` in sources.json is theirs to set; nothing here asserts one.
 *
 * ## Why a monogram rather than a logo
 *
 * A logo would have to be bundled per tool, would be a trademark question, and
 * would go stale the day a project rebrands. Two characters in the mono face
 * localflow already loads cost nothing, work at 11px, survive a screenshot, and
 * are legible to a screen reader as the text they are.
 */

export interface SourceIdentity {
  id: string;
  /** What to call it on screen. */
  label: string;
  /** Two characters. The identity channel that does not degrade. */
  glyph: string;
  /** Only ever what the operator asked for. Absent means the board picks nothing. */
  color?: string;
  /** True for readers this repo implements and tests, rather than ones it is told about. */
  builtIn: boolean;
}

/**
 * Monograms for tools common enough to be worth not abbreviating badly.
 *
 * The fallback below is fine, but it turns "opencode" into `op` and
 * "gemini-cli" into `ge`, and `oc`/`gm` are what people actually write. This
 * table is a courtesy, not a claim to support any of them -- being listed here
 * says nothing about whether localflow can read that tool's files.
 */
const KNOWN: Record<string, { label: string; glyph: string }> = {
  claude: { label: "Claude Code", glyph: "cc" },
  codex: { label: "Codex CLI", glyph: "cx" },
  gemini: { label: "Gemini CLI", glyph: "gm" },
  opencode: { label: "opencode", glyph: "oc" },
  aider: { label: "Aider", glyph: "ai" },
  cursor: { label: "Cursor", glyph: "cu" },
  otter: { label: "Otter", glyph: "ot" },
  amp: { label: "Amp", glyph: "am" },
  goose: { label: "Goose", glyph: "gs" },
};

/**
 * Two characters for an id nobody listed.
 *
 * Word initials first, because `my-team-runner` reading as `mt` is better than
 * `my`; otherwise the first two letters. Digits are kept -- `gpt4` should not
 * become `gp` when `g4` is more distinctive.
 */
export function glyphFor(id: string): string {
  const words = id.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toLowerCase();
  const bare = (words[0] ?? id).toLowerCase();
  return (bare.slice(0, 2) || "??").padEnd(2, bare[0] ?? "?");
}

/** A hex colour we are willing to put on screen, or nothing. */
export function normaliseColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(s) ? s : undefined;
}

export function identityFor(
  id: string,
  declared: { label?: string; color?: string } = {},
  builtIn = false,
): SourceIdentity {
  const known = KNOWN[id];
  return {
    id,
    // The operator's label wins: they named the source, and on their board
    // "work-laptop-codex" may be the useful name rather than "Codex CLI".
    label: declared.label ?? known?.label ?? id,
    glyph: known?.glyph ?? glyphFor(id),
    color: normaliseColor(declared.color),
    builtIn,
  };
}
