#!/usr/bin/env python3
"""Builds the localflow demo reel from captured dashboard screenshots.

The first version of this demo was a terminal recording, which showed everything
about localflow except the thing it is — a board. So the reel is now the real UI,
captured from a real server against a real machine by `tools/capture.mjs`, cut
together here with captions.

Every frame is composited rather than screen-recorded, so the result is
deterministic: same screenshots in, same video out, and a caption can be fixed
without re-running the browser.

Usage: mkdemo.py <frames-dir> <out-dir>
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

# ---- brand -------------------------------------------------------------------
# Mirrors branding/tokens/tokens.css. Literals only because this is a build tool
# outside the token pipeline; if these drift, tokens.css wins.
BG = (15, 20, 25)          # --ul-bg
RAISED = (23, 29, 38)      # --ul-bg-raised
LINE = (35, 43, 53)        # --ul-line
HEADING = (232, 237, 242)  # --ul-heading
BODY = (168, 179, 191)     # --ul-body
MUTED = (124, 136, 150)    # --ul-muted
FAINT = (90, 102, 115)     # --ul-faint
ACCENT = (0, 212, 170)     # --ul-accent
WARN = (232, 179, 57)      # --ul-warn

FONT_DIR = pathlib.Path.home() / ".local/share/fonts"
REG = FONT_DIR / "JetBrainsMonoNerdFont-Regular.ttf"
BOLD = FONT_DIR / "JetBrainsMonoNerdFont-Bold.ttf"

W, H = 1280, 800
FPS = 20
CAPTION_H = 96
FADE = 0.3   # seconds of crossfade between steps

f_cap = ImageFont.truetype(str(BOLD), 21)
f_sub = ImageFont.truetype(str(REG), 16)
f_big = ImageFont.truetype(str(BOLD), 40)
f_mid = ImageFont.truetype(str(REG), 21)
f_small = ImageFont.truetype(str(REG), 15)


def canvas() -> Image.Image:
    return Image.new("RGB", (W, H), BG)


def wrap(text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    """Greedy wrap. A caption that runs off the frame is a caption nobody read."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if font.getlength(trial) <= width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_caption(img: Image.Image, title: str, sub: str | None) -> None:
    """The caption bar. Accent rule on the left so the eye starts there."""
    d = ImageDraw.Draw(img)
    sub_lines = wrap(sub, f_sub, W - 140) if sub else []
    h = 44 + 22 * len(sub_lines) + 22
    y0 = H - h
    d.rectangle([0, y0, W, H], fill=RAISED)
    d.rectangle([0, y0, W, y0 + 1], fill=LINE)
    d.rectangle([40, y0 + 20, 43, H - 20], fill=ACCENT)
    d.text((60, y0 + 18), title, font=f_cap, fill=HEADING)
    y = y0 + 48
    for line in sub_lines:
        d.text((60, y), line, font=f_sub, fill=MUTED)
        y += 22


def fit(src: Image.Image, box_h: int, crop: tuple[int, int, int, int] | None) -> Image.Image:
    """Crop a region of the screenshot and scale it to fill the frame width."""
    im = src.crop(crop) if crop else src
    scale = W / im.width
    if im.height * scale > box_h:
        scale = box_h / im.height
    return im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)


def caption_height(sub: str | None) -> int:
    return 44 + 22 * len(wrap(sub, f_sub, W - 140) if sub else []) + 22


def shot_frame(src: Image.Image, crop, title, sub) -> Image.Image:
    img = canvas()
    body_h = H - caption_height(sub)
    im = fit(src, body_h - 24, crop)
    x = (W - im.width) // 2
    y = (body_h - im.height) // 2
    # A hairline around the screenshot so it reads as a window rather than as
    # the page bleeding into the frame.
    ImageDraw.Draw(img).rectangle([x - 1, y - 1, x + im.width, y + im.height], outline=LINE)
    img.paste(im, (x, y))
    draw_caption(img, title, sub)
    return img


def card_frame(lines: list[tuple[str, str]]) -> Image.Image:
    """A text card. Each line is (style, text) with style in big/mid/small/accent."""
    img = canvas()
    d = ImageDraw.Draw(img)
    fonts = {"big": f_big, "mid": f_mid, "small": f_small, "accent": f_mid}
    colours = {"big": HEADING, "mid": BODY, "small": FAINT, "accent": ACCENT}
    gaps = {"big": 58, "mid": 34, "small": 26, "accent": 34}
    total = sum(gaps[s] for s, _ in lines)
    y = (H - total) // 2
    for style, text in lines:
        if text:
            d.text((110, y), text, font=fonts[style], fill=colours[style])
        y += gaps[style]
    return img


def lerp_box(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))


def build(frames_dir: pathlib.Path, out: pathlib.Path) -> int:
    entries = json.loads((frames_dir / "manifest.json").read_text())
    src = {m["name"]: Image.open(frames_dir / m["file"]).convert("RGB") for m in entries}

    # Crops were measured in the browser by capture.mjs — getBoundingClientRect
    # on the element that matters — so a dialog is framed exactly rather than
    # guessed off the PNG, and it keeps working when the layout moves.
    rects = {m["name"]: m["rect"] for m in entries if m.get("rect")}

    def box(name):
        r = rects.get(name)
        return (r[0], r[1], r[0] + r[2], r[1] + r[3]) if r else None

    steps: list[dict] = [
        {"card": [
            ("big", "localflow"),
            ("mid", ""),
            ("mid", "Four terminals open. Two of them are"),
            ("mid", "waiting for you, and you cannot see which."),
            ("small", ""),
            ("small", "A board for the Claude Code sessions already running on your machine."),
        ], "hold": 3.0},

        {"shot": "board", "hold": 4.2,
         "title": "Every session on this machine, on one board",
         "sub": "Read from the registry and transcripts already on your disk. Nothing is sent anywhere."},

        {"shot": "totals", "crop": box("totals"), "hold": 3.4,
         "title": "What all of it has cost you",
         "sub": "Priced from measured tokens — not reported by the provider, and not guessed."},

        {"shot": "card-focus", "crop": box("card-focus"), "hold": 4.2,
         "title": "Each card: model, tokens, cost, cache share",
         "sub": "The bar is the share served from cache. It is the single biggest lever on the bill."},

        {"shot": "waiting", "crop": box("waiting"), "hold": 4.6,
         "title": "Waiting on you",
         "sub": "Idle with an empty queue — it wants an answer. A session blocked on a question is invisible from the terminal you are not looking at."},

        {"shot": "drawer", "crop": box("drawer"), "hold": 4.4,
         "title": "Open one: what it spent, what it called",
         "sub": "Tokens, cost, cache rate, the last prompt, and every tool it used."},

        {"shot": "graph", "crop": box("graph"), "hold": 4.6,
         "title": "And the fan-out it actually performed",
         "sub": "Ten agent calls, none of them parallel. The transcript records that; nothing else shows it to you."},

        {"shot": "actions", "crop": box("actions"), "hold": 4.4,
         "title": "Reprompt, reroute, interrupt",
         "sub": "And what it noticed about this run — three verifiers asking the same question, a fan-out where children failed, a session running cold on cache."},

        {"card": [
            ("mid", "graphlint lints the graph you wrote."),
            ("big", "This is the one that ran."),
            ("mid", ""),
            ("accent", "localflow graph 62173ece | graphlint check -"),
            ("accent", "localflow graph 62173ece | preflight estimate -"),
            ("small", ""),
            ("small", "Shape is measured. Whether a barrier was needed is graphlint's question —"),
            ("small", "and now it has real graphs to ask it about."),
        ], "hold": 5.0},

        {"shot": "reroute", "crop": box("reroute"), "hold": 4.4,
         "title": "Reroute: same conversation, a different model",
         "sub": "Forks the session so the original is left exactly as it was."},

        {"shot": "refuse", "crop": box("refuse"), "hold": 4.6,
         "title": "A move with nothing behind it is refused",
         "sub": "You cannot drag a session into running: what makes it run is having something to do. The lane says why, instead of snapping the card back."},

        {"shot": "spawn", "crop": box("spawn"), "hold": 4.2,
         "title": "Start a background agent from the board",
         "sub": "claude --bg, in a directory you allowed. It appears within one poll."},

        {"card": [
            ("mid", "Watching is the default."),
            ("small", ""),
            ("mid", "Actions are off until you arm them. The server binds to loopback"),
            ("mid", "and checks Host and Origin — this process can start Claude"),
            ("mid", "sessions, so a web page must not be able to reach it."),
            ("small", ""),
            ("small", "All four refusals are asserted in CI on every commit."),
        ], "hold": 4.6},

        {"card": [
            ("accent", "npx localflow"),
            ("small", ""),
            ("big", "unchained-labs.github.io/localflow"),
            ("small", ""),
            ("small", "Zero runtime deps. Reads only your own disk. MIT."),
        ], "hold": 3.4},
    ]

    frames = out / "frames"
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True)

    rendered: list[Image.Image] = []
    for st in steps:
        n = max(1, int(FPS * st["hold"]))
        if "card" in st:
            base = card_frame(st["card"])
            rendered.extend([base] * n)
            continue

        im = src[st["shot"]]
        crop = st.get("crop")
        to = st.get("to")
        if to:
            # A slow push, for the shots where the eye needs leading somewhere.
            for i in range(n):
                t = i / max(1, n - 1)
                rendered.append(shot_frame(im, lerp_box(crop, to, t), st["title"], st.get("sub")))
        else:
            base = shot_frame(im, crop, st["title"], st.get("sub"))
            rendered.extend([base] * n)

    # Crossfade the joins. Held frames are the same object, so this only does
    # real work at the boundaries.
    fade = int(FPS * FADE)
    out_frames: list[Image.Image] = []
    i = 0
    for si, st in enumerate(steps):
        n = max(1, int(FPS * st["hold"]))
        chunk = rendered[i : i + n]
        i += n
        if si > 0 and fade:
            prev = out_frames[-1]
            for k in range(fade):
                a = k / fade
                out_frames.append(Image.blend(prev, chunk[0], a))
        out_frames.extend(chunk)

    for k, img in enumerate(out_frames, 1):
        img.save(frames / f"f{k:05d}.png")
    return len(out_frames)


def encode(out: pathlib.Path, name: str, n: int) -> None:
    pat = out / "frames" / "f%05d.png"
    mp4 = out / f"{name}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(pat),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "21",
         "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", str(mp4)],
        check=True,
    )
    # Two-pass GIF: a per-clip palette is the difference between crisp UI text
    # and dithered mush. Half size and half the frame rate — this reel is mostly
    # held frames, so dropping to 10fps costs nothing visible and halves a file
    # that has to load inside a README.
    pal = out / "palette.png"
    scale = "fps=10,scale=iw/2:ih/2:flags=lanczos"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(pat),
         "-vf", f"{scale},palettegen=max_colors=128:stats_mode=diff", str(pal)],
        check=True,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(pat), "-i", str(pal),
         "-lavfi", f"{scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
         "-loop", "0", str(out / f"{name}.gif")],
        check=True,
    )
    pal.unlink(missing_ok=True)
    shutil.rmtree(out / "frames")
    print(f"   {name}.mp4  {mp4.stat().st_size // 1024}KB")
    print(f"   {name}.gif  {(out / f'{name}.gif').stat().st_size // 1024}KB   ({n} frames, {n / FPS:.1f}s)")


if __name__ == "__main__":
    frames_dir = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    encode(out, "localflow", build(frames_dir, out))
