#!/usr/bin/env python3
"""Generates the localflow mark and lockups.

A sibling of the Unchained Labs mark rather than a copy. The parent is a scope
node fanning out to three — the shape of a graph. localflow is not about fanning
out, it is about *where the work sits and which way it is going*, so its mark is
three lanes hung from a shared top edge and shortening to the right: a board
draining. The shared edge is what gives it direction; centring the bars made the
same three shapes read as a bar chart, which is a picture of quantities rather
than of flow.

Everything is computed. Lane pitch comes from the total width and the gutter, so
the bars are evenly spaced by construction, and the heights are a fixed ratio of
each other rather than three numbers chosen by eye. Same accent, same 32-grid,
same fully-round caps as the parent, so the two sit together.

Three bars, not four, even though the board has four lanes: at 16px a fourth
stroke closes the gutters and the mark turns into a smear. Legibility beats
literalism.

Usage: mkmark.py     (writes ../assets/logo)
"""
from __future__ import annotations

import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "assets" / "logo"
OUT.mkdir(parents=True, exist_ok=True)

# Straight out of branding/tokens/tokens.css — never restated by eye.
ACCENT = "#00D4AA"
INK = "#0F1419"
PAPER = "#E8EDF2"
MUTED = "#7C8896"
FAINT = "#5A6673"

SIZE = 32
LANES = 3
BAR_W = 6.0
GUTTER = 2.5
TOP = 5.5
TALLEST = 21.0
# Each lane keeps this share of the one before it. One ratio instead of three
# heights: the silhouette stays consistent if the grid ever changes.
DECAY = 0.69

TOTAL_W = LANES * BAR_W + (LANES - 1) * GUTTER
X0 = (SIZE - TOTAL_W) / 2
XS = [X0 + i * (BAR_W + GUTTER) for i in range(LANES)]
HS = [TALLEST * (DECAY**i) for i in range(LANES)]


def bar(x: float, h: float, fill: str) -> str:
    # Radius is half the width, so the caps are true semicircles at any size.
    return (
        f'<rect x="{x:.2f}" y="{TOP:.2f}" width="{BAR_W:.2f}" height="{h:.2f}" '
        f'rx="{BAR_W / 2:.2f}" fill="{fill}"/>'
    )


def body(colours: list[str]) -> str:
    return "\n  ".join(bar(x, h, c) for x, h, c in zip(XS, HS, colours))


def svg(inner: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" '
        f'width="{SIZE}" height="{SIZE}" role="img" aria-label="localflow">\n  {inner}\n</svg>\n'
    )


def write(name: str, content: str) -> None:
    (OUT / name).write_text(content)
    print(f"   {name:<28} {len(content)}B")


# ---- lockups -----------------------------------------------------------------
# "localflow" set in the wordmark's own geometry rather than a font reference, so
# the SVG renders identically on a machine that has never heard of Space Grotesk.
# The mark sits on the cap height and the gap is one lane gutter, doubled.
WORD_X = SIZE + GUTTER * 2


def lockup(mark_colours: list[str], text_fill: str, width: int = 168) -> str:
    inner = (
        f'<g>{body(mark_colours)}</g>\n  '
        f'<text x="{WORD_X}" y="21.6" fill="{text_fill}" '
        f'font-family="Space Grotesk, Inter, Helvetica Neue, Arial, sans-serif" '
        f'font-size="17" font-weight="600" letter-spacing="-0.4">localflow</text>'
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {SIZE}" '
        f'width="{width}" height="{SIZE}" role="img" aria-label="localflow">\n  {inner}\n</svg>\n'
    )


def main() -> None:
    on_dark = [ACCENT, PAPER, MUTED]
    on_light = [ACCENT, INK, FAINT]

    write("mark-accent.svg", svg(body(on_dark)))
    write("mark-dark.svg", svg(body(on_light)))
    write("mark-mono.svg", svg(body(["currentColor"] * LANES)))
    # The favicon is the mark unchanged. It was designed to survive 16px, so
    # there is nothing to simplify — a favicon that needs a different drawing is
    # a mark that did not work.
    write("favicon.svg", svg(body(on_dark)))

    write("lockup-horizontal.svg", lockup(on_dark, PAPER))
    write("lockup-horizontal-dark.svg", lockup(on_light, INK))
    write("lockup-horizontal-mono.svg", lockup(["currentColor"] * LANES, "currentColor"))

    print()
    print(f"   lanes  x = {', '.join(f'{x:.2f}' for x in XS)}  (pitch {BAR_W + GUTTER:.2f}, even by construction)")
    print(f"   heights   {', '.join(f'{h:.2f}' for h in HS)}  (ratio {DECAY} applied {LANES - 1}x)")
    print(f"   block is {TOTAL_W:.2f} wide, centred in {SIZE} -> margin {X0:.2f} each side")


if __name__ == "__main__":
    main()
