/**
 * The handful of helpers every view uses.
 *
 * Split out of app.ts once the workflow editor became its own file: two
 * modules each defining their own `el` is two ways to build a node that drift
 * apart, and a formatting function copied between them is a number that
 * eventually prints two ways.
 */

export const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...kids: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = String(v);
    else if (v !== undefined && v !== null) (n as Record<string, unknown>)[k] = v;
  }
  for (const kid of kids) if (kid != null) n.append(kid as Node | string);
  return n;
}

export const NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** Attach a `<title>`, which is how an SVG node gets a tooltip. */
export function titled<T extends SVGElement>(node: T, text: string): T {
  const t = document.createElementNS(NS, "title");
  t.textContent = text;
  node.append(t);
  return node;
}

// ---- formatting -------------------------------------------------------------

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function money(usd: number | null): string {
  if (usd === null) return "—";
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

export function age(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** A duration, for a run that has both ends. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const shortModel = (m?: string) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "");
export const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");

/** An element's usable width: what is inside its own padding. */
export function innerWidthOf(node: HTMLElement, fallback = 520): number {
  const w = node.clientWidth;
  if (!w) return fallback;
  const cs = getComputedStyle(node);
  const inner = w - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
  return inner > 80 ? inner : fallback;
}

export function toast(msg: string, kind: "ok" | "err" | "info" = "info", ms = 6000): void {
  const t = el("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}
