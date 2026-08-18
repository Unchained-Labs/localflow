/**
 * Charts, in SVG, with no dependency.
 *
 * localflow ships one HTML file and one script; adding a charting library to
 * draw six plots would be more bytes of vendor code than the entire app. These
 * are the four forms the metrics actually need, and nothing else.
 *
 * The palette is the validated categorical theme — six hues, checked with the
 * dataviz validator against this app's own dark surface (#0F1419): lightness
 * band, chroma floor, CVD separation, normal-vision separation and contrast all
 * pass. Do not add a seventh hue by eye. A seventh series folds into "Other",
 * drawn in neutral ink and always labelled, because a grey is not a series —
 * it is the absence of one.
 *
 * Two rules the marks follow, both about not lying:
 *
 *   * **A bar of zero draws nothing, and a bucket of zero still occupies its
 *     slot.** Dropping empty buckets turns a quiet week into a straight line
 *     between two busy ones.
 *   * **Unpriced work is hatched, not omitted and not drawn as zero.** A model
 *     with no known rate contributes no dollars, and the hatch is how the chart
 *     says "there was activity here that no total includes".
 */

export const SERIES = [
  "var(--viz-1)",
  "var(--viz-2)",
  "var(--viz-3)",
  "var(--viz-4)",
  "var(--viz-5)",
  "var(--viz-6)",
] as const;

/** Beyond the palette, everything is one neutral remainder. Never a new hue. */
export const OTHER = "var(--ul-faint)";

export const seriesColor = (i: number): string => (i < SERIES.length ? SERIES[i]! : OTHER);

const NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** The 45° hatch used for "activity we could not price". Defined once per chart. */
function hatchDefs(id: string): SVGDefsElement {
  const defs = svgEl("defs");
  const pattern = svgEl("pattern", {
    id,
    width: 6,
    height: 6,
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(45)",
  });
  pattern.append(
    svgEl("rect", { width: 6, height: 6, fill: "var(--ul-bg-inset)" }),
    svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--ul-faint)", "stroke-width": 2 }),
  );
  defs.append(pattern);
  return defs;
}

function title(node: SVGElement, text: string): void {
  const t = svgEl("title");
  t.textContent = text;
  node.append(t);
}

export interface TimePoint {
  at: number;
  value: number;
  /** Portion of the bucket that could not be priced, in the same unit. */
  unpriced?: number;
  label: string;
}

/**
 * Change over time, as bars.
 *
 * Bars rather than a line because these buckets are discrete counts and sums —
 * a line between them implies the value passed through the space in between,
 * and it did not.
 */
export function timeBars(points: TimePoint[], opts: { height?: number; format?: (n: number) => string } = {}): SVGSVGElement {
  const H = opts.height ?? 120;
  const W = Math.max(points.length * 8, 240);
  const pad = { top: 8, bottom: 18, left: 0, right: 0 };
  const plot = H - pad.top - pad.bottom;
  const fmt = opts.format ?? ((n) => String(Math.round(n)));
  const max = Math.max(1, ...points.map((p) => p.value + (p.unpriced ?? 0)));
  const hatchId = `hatch-${Math.round(max * 1000)}-${points.length}`;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
    class: "chart chart-time",
    role: "img",
  });
  svg.append(hatchDefs(hatchId));

  // Baseline: recessive, but present. Without it a chart of small values floats.
  svg.append(
    svgEl("line", {
      x1: 0,
      y1: H - pad.bottom,
      x2: W,
      y2: H - pad.bottom,
      stroke: "var(--ul-line)",
      "stroke-width": 1,
    }),
  );

  const slot = W / Math.max(points.length, 1);
  const barW = Math.max(2, slot - 2); // 2px surface gap between adjacent bars
  points.forEach((p, i) => {
    const x = i * slot + (slot - barW) / 2;
    const total = p.value + (p.unpriced ?? 0);
    if (total <= 0) return; // a zero bar draws nothing; its slot still exists
    let y = H - pad.bottom;

    for (const [val, fill] of [
      [p.value, "var(--viz-1)"],
      [p.unpriced ?? 0, `url(#${hatchId})`],
    ] as const) {
      if (val <= 0) continue;
      const h = Math.max(1, (val / max) * plot);
      y -= h;
      const rect = svgEl("rect", {
        x,
        y,
        width: barW,
        height: h,
        fill,
        rx: Math.min(2, barW / 2),
      });
      title(
        rect,
        `${p.label}\n${fmt(p.value)}${p.unpriced ? ` (+ ${fmt(p.unpriced)} unpriced)` : ""}`,
      );
      svg.append(rect);
    }
  });

  return svg;
}

export interface SliceDatum {
  key: string;
  value: number;
  /** Shown in the row's right-hand label. */
  detail: string;
  unpriced?: boolean;
}

/**
 * Identity and magnitude together, as horizontal bars.
 *
 * Horizontal because the labels are model ids and directory paths, and a
 * vertical bar chart would either truncate them or rotate them 45°, which is
 * the reliable way to make a chart nobody reads.
 */
export function breakdown(rows: SliceDatum[], opts: { max?: number } = {}): HTMLElement {
  const shown = rows.slice(0, opts.max ?? 6);
  const rest = rows.slice(opts.max ?? 6);
  if (rest.length) {
    shown.push({
      key: `${rest.length} more`,
      value: rest.reduce((n, r) => n + r.value, 0),
      detail: "grouped",
    });
  }
  const max = Math.max(1, ...shown.map((r) => r.value));

  const wrap = document.createElement("div");
  wrap.className = "chart-rows";
  shown.forEach((row, i) => {
    const line = document.createElement("div");
    line.className = "chart-row";
    // The colour swatch is identity; the text beside it repeats that identity,
    // so nothing here depends on telling two hues apart.
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = i < shown.length - (rest.length ? 1 : 0) ? seriesColor(i) : OTHER;

    const label = document.createElement("span");
    label.className = "chart-key";
    label.textContent = row.key;

    const track = document.createElement("span");
    track.className = "chart-track";
    const fill = document.createElement("span");
    fill.className = "chart-fill";
    fill.style.width = `${(row.value / max) * 100}%`;
    fill.style.background = row.unpriced ? "var(--ul-bg-inset)" : swatch.style.background;
    if (row.unpriced) fill.style.boxShadow = "inset 0 0 0 1px var(--ul-faint)";
    track.append(fill);

    const detail = document.createElement("span");
    detail.className = "chart-detail";
    detail.textContent = row.detail;

    line.append(swatch, label, track, detail);
    wrap.append(line);
  });
  return wrap;
}

/**
 * A distribution, as a histogram.
 *
 * Used for observed fan-out width: how wide the parallelism actually got, which
 * is a fact about a run rather than a number in a spec.
 */
export function histogram(bins: { bin: string; count: number; bad?: number }[]): SVGSVGElement {
  const H = 110;
  const W = Math.max(bins.length * 44, 200);
  const pad = { top: 10, bottom: 22 };
  const plot = H - pad.top - pad.bottom;
  const max = Math.max(1, ...bins.map((b) => b.count));

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart chart-hist", role: "img" });
  svg.append(
    svgEl("line", {
      x1: 0,
      y1: H - pad.bottom,
      x2: W,
      y2: H - pad.bottom,
      stroke: "var(--ul-line)",
      "stroke-width": 1,
    }),
  );

  const slot = W / Math.max(bins.length, 1);
  const barW = Math.max(6, slot - 12);
  bins.forEach((b, i) => {
    const x = i * slot + (slot - barW) / 2;
    const h = Math.max(1, (b.count / max) * plot);
    const y = H - pad.bottom - h;
    const rect = svgEl("rect", { x, y, width: barW, height: h, rx: 2, fill: "var(--viz-1)" });
    title(rect, `width ${b.bin}: ${b.count} fan-out(s)${b.bad ? `, ${b.bad} with errors` : ""}`);
    svg.append(rect);

    // Errors ride on top in the reserved status hue — a separate axis from the
    // categorical palette, and never used for "series 2".
    if (b.bad) {
      const eh = Math.max(1, (Math.min(b.bad, b.count) / max) * plot);
      svg.append(svgEl("rect", { x, y: H - pad.bottom - eh, width: barW, height: eh, rx: 2, fill: "var(--ul-down)" }));
    }

    const label = svgEl("text", {
      x: i * slot + slot / 2,
      y: H - 6,
      "text-anchor": "middle",
      class: "chart-axis",
    });
    label.textContent = b.bin;
    svg.append(label);
  });
  return svg;
}

/** A single number that does not need a plot behind it. */
export function statTile(label: string, value: string, note?: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "stat";
  const l = document.createElement("div");
  l.className = "stat-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "stat-value";
  v.textContent = value;
  tile.append(l, v);
  if (note) {
    const n = document.createElement("div");
    n.className = "stat-note";
    n.textContent = note;
    tile.append(n);
  }
  return tile;
}
