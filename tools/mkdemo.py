#!/usr/bin/env python3
"""Builds the localflow demo reel from captured dashboard screenshots.

The first version of this demo was a terminal recording, which showed everything
about localflow except the thing it is — a board. So the reel is the real UI,
captured from a real server by `tools/capture.mjs` against the machine
`tools/fixture.mjs` writes, and cut together here with captions.

Every frame is composited rather than screen-recorded, so the result is
deterministic: same screenshots in, same video out, and a caption can be fixed
without re-running the browser.

**Two cuts, from one render.** The MP4 is the full tour. The GIF is the subset
of steps marked `gif=True`, at half size and half the frame rate, because it has
to load inside a README — and a GIF of the whole tour is a two-megabyte
autoplaying wall. Anything the README drops is still one click away in the
video, so the subset is chosen for what reads at 640px rather than for what
matters least.

**The captions are claims about the fixture.** "Ten agent calls in four groups"
is true because tools/fixture.mjs writes exactly that. Change the fixture and
the caption that reads it out has to change with it.

Usage: mkdemo.py <frames-dir> <out-dir>
"""
from __future__ import annotations

import json
import os
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


def font_file(*names: str) -> pathlib.Path:
    """First of `names` that exists, searched where fonts actually live.

    The old version hard-coded one path under ~/.local/share/fonts, so this tool
    only ran on the machine it was written on — which is the same reason the
    reel needed that machine's sessions. Fall back rather than fail: a caption in
    DejaVu is a worse reel than one in JetBrains Mono, and no reel at all is
    worse than both.
    """
    roots = [
        pathlib.Path.home() / ".local/share/fonts",
        pathlib.Path("/usr/local/share/fonts"),
        pathlib.Path("/usr/share/fonts"),
        pathlib.Path("/Library/Fonts"),
        pathlib.Path.home() / "Library/Fonts",
    ]
    for name in names:
        for root in roots:
            if not root.exists():
                continue
            direct = root / name
            if direct.exists():
                return direct
            hit = next(root.rglob(name), None)
            if hit:
                return hit
    raise SystemExit(f"mkdemo: none of {', '.join(names)} found — install a mono font or edit font_file()")


REG = font_file("JetBrainsMonoNerdFont-Regular.ttf", "JetBrainsMono-Regular.ttf", "DejaVuSansMono.ttf")
BOLD = font_file("JetBrainsMonoNerdFont-Bold.ttf", "JetBrainsMono-Bold.ttf", "DejaVuSansMono-Bold.ttf")

W, H = 1280, 800
FPS = 20
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


# How far a crop may be blown up. A card is 380px wide and the frame is 1280, so
# filling the width means 3.4x — which is a screenshot of text rendered at three
# times its own resolution, and it looks it. Capped and centred instead: smaller
# in frame, but the type stays type.
MAX_ZOOM = 2.0


def fit(src: Image.Image, box_h: int, crop: tuple[int, int, int, int] | None) -> Image.Image:
    """Crop a region of the screenshot and scale it into the frame."""
    im = src.crop(crop) if crop else src
    scale = min(W / im.width, MAX_ZOOM)
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


def steps_for(box) -> list[dict]:
    """The reel, in order.

    `gif` marks the steps the README's GIF keeps. The board, the money and the
    four answers you cannot get anywhere else are in it; the dialogs and the
    prose cards are the video's job.
    """
    return [
        {"card": [
            ("big", "localflow"),
            ("mid", ""),
            ("mid", "Four terminals open. Two of them are"),
            ("mid", "waiting for you, and you cannot see which."),
            ("small", ""),
            ("small", "A board for the Claude Code sessions already running on your machine."),
        ], "hold": 3.0, "gif": True},

        {"shot": "board", "hold": 3.8, "gif": True,
         "title": "Every session on this machine, on one board",
         "sub": "Read from the registry and the transcripts already on your disk. Nothing is sent anywhere."},

        {"shot": "totals", "crop": box("totals"), "hold": 3.0, "gif": True,
         "title": "What all of it has cost you",
         "sub": "Priced from measured tokens — not reported by the provider, and not guessed."},

        {"shot": "card-focus", "crop": box("card-focus"), "hold": 3.6, "gif": True,
         "title": "Each card: model, tokens, cost, cache share",
         "sub": "The bar is the share served from cache. It is the single biggest lever on the bill."},

        {"shot": "sources", "crop": box("sources"), "hold": 4.2, "gif": True,
         "title": "Other people's agents, on the same board",
         "sub": "Codex and Gemini sessions, read through a shape you declared rather than one this repo guessed. "
                "The model nobody supplied a rate for says cost unknown — never $0.00."},

        {"shot": "waiting", "crop": box("waiting"), "hold": 4.0, "gif": True,
         "title": "Waiting on you",
         "sub": "Idle with an empty queue — it wants an answer. A session blocked on a question is invisible "
                "from the terminal you are not looking at."},

        {"shot": "drawer", "crop": box("drawer"), "hold": 3.8, "gif": True,
         "title": "Open one: what it spent, what it called",
         "sub": "Tokens, cost, cache rate, the last prompt, and every tool it used."},

        {"shot": "graph", "crop": box("graph"), "hold": 4.2, "gif": True,
         "title": "And the fan-out it actually performed",
         "sub": "Ten agent calls in four groups. The widest ran five wide and two of its children came back "
                "with an error. The transcript records that; nothing else shows it to you."},

        {"shot": "actions", "crop": box("actions"), "hold": 4.0,
         "title": "Reprompt, reroute, interrupt",
         "sub": "And what it noticed about this run — a fan-out whose children failed, and three verifiers "
                "whose prompts are 82% alike, which is one verifier at three times the price."},

        {"card": [
            ("mid", "graphlint lints the graph you wrote."),
            ("big", "This is the one that ran."),
            ("mid", ""),
            ("accent", "localflow review 62173ece"),
            ("small", ""),
            ("small", "Shape is measured. Whether a barrier was needed is graphlint's question —"),
            ("small", "and now it has real graphs to ask it about."),
        ], "hold": 3.8},

        # Deliberately not in the GIF: it is a panel of prose, and prose at 640px
        # is a grey texture. The video can hold it long enough to read.
        {"shot": "family", "crop": box("family"), "hold": 5.2,
         "title": "So hand it to the tools that judge graphs",
         "sub": "graphlint lints it, preflight prices it, decorrelate plans the lenses that panel should have "
                "used. Nothing is reimplemented here — and a tool that is not installed reports that it is "
                "not installed, never that it found nothing."},

        {"shot": "reroute", "crop": box("reroute"), "hold": 3.8,
         "title": "Reroute: same conversation, a different model",
         "sub": "Forks the session so the original is left exactly as it was."},

        {"shot": "refuse", "crop": box("refuse"), "hold": 4.0,
         "title": "A move with nothing behind it is refused",
         "sub": "You cannot drag a session into running: what makes it run is having something to do. "
                "The lane says why, instead of snapping the card back."},

        {"shot": "spawn", "crop": box("spawn"), "hold": 3.6,
         "title": "Start a background agent from the board",
         "sub": "claude --bg, in a directory you allowed. It appears within one poll."},

        # ---- the metrics tab, which is most of what this reel was missing ----
        {"shot": "metrics", "crop": box("metrics"), "hold": 3.6, "gif": True,
         "title": "Then the question a board of running agents is opened with",
         "sub": "Sessions, tokens, spend, cache hit rate, tool errors. Sessions nobody could price are "
                "counted beside the total rather than folded into it as zero."},

        {"shot": "burn", "crop": box("burn"), "hold": 4.6, "gif": True,
         "title": "How fast the money is going",
         "sub": "Every rate is divided by the part of its window this board could actually see, never by the "
                "window itself — and a window in which nothing could be priced reports unknown, not $0.00/h."},

        {"shot": "block", "crop": box("block"), "hold": 4.8, "gif": True,
         "title": "And the five-hour block it is going into",
         "sub": "Usage limits reset on rolling five-hour blocks, so “spent today” is the wrong denominator — "
                "midnight is not a thing the limit knows about. A projection needs a quarter-hour of block "
                "behind it; under that there is only the reason there isn't one."},

        {"shot": "spend", "crop": box("spend"), "hold": 4.4, "gif": True,
         "title": "Spend over time, and where the tokens went",
         "sub": "Hatched means work nobody could price: it happened, and no total above includes it. "
                "A flat line through a period that actually cost something is the failure worth engineering against."},

        {"shot": "bytool", "crop": box("bytool"), "hold": 3.8,
         "title": "Which agent produced the work, and in which project",
         "sub": "Six categorical hues, validated for colour-vision separation against these surfaces. "
                "A seventh series is never a new hue — it folds into a labelled neutral."},

        {"shot": "fanout", "crop": box("fanout"), "hold": 3.8,
         "title": "How wide the parallelism actually got",
         "sub": "Across every session on the board rather than one run. Red is the share that came back "
                "with a tool error."},

        {"shot": "water", "crop": box("water"), "hold": 4.8, "gif": True,
         "title": "And what the answers cost in freshwater",
         "sub": "The same token counts, handed to soif — localflow does no water arithmetic of its own. "
                "The range never leaves the number, and a model soif had to assume a tier for is drawn hollow."},

        {"shot": "archive", "crop": box("archive"), "hold": 3.4,
         "title": "Every session, not just the recent ones",
         "sub": "The board keeps a bounded history on purpose. “Show me everything I have ever run” is a "
                "different question, and it gets its own answer."},

        {"shot": "devices", "crop": box("devices"), "hold": 4.6, "gif": True,
         "title": "Sessions that survive the train tunnel",
         "sub": "Started over ssh inside tmux on machines you declared, so a dropped connection costs you a "
                "reconnect rather than the session. No credentials are stored; the panel names the machine "
                "missing tmux rather than failing opaquely."},

        {"card": [
            ("mid", "Watching is the default."),
            ("small", ""),
            ("mid", "Actions are off until you arm them, and starting work on another"),
            ("mid", "machine is a second flag. The server binds to loopback and checks"),
            ("mid", "Host and Origin — this process can start Claude sessions, so a"),
            ("mid", "web page must not be able to reach it."),
            ("small", ""),
            ("small", "All four refusals are asserted in CI on every commit."),
        ], "hold": 4.4},

        {"card": [
            ("accent", "npx localflow"),
            ("small", ""),
            ("big", "unchained-labs.github.io/localflow"),
            ("small", ""),
            ("small", "Zero runtime deps. Reads only your own disk. MIT."),
        ], "hold": 3.2, "gif": True},
    ]


def render(frames_dir: pathlib.Path) -> tuple[list[list[Image.Image]], list[bool]]:
    """Render every step to a list of frames. Held frames share one image."""
    entries = json.loads((frames_dir / "manifest.json").read_text())
    src = {m["name"]: Image.open(frames_dir / m["file"]).convert("RGB") for m in entries}

    # Crops were measured in the browser by capture.mjs — getBoundingClientRect
    # on the element that matters — so a panel is framed exactly rather than
    # guessed off the PNG, and it keeps working when the layout moves.
    rects = {m["name"]: m["rect"] for m in entries if m.get("rect")}

    def box(name):
        r = rects.get(name)
        return (r[0], r[1], r[0] + r[2], r[1] + r[3]) if r else None

    chunks: list[list[Image.Image]] = []
    in_gif: list[bool] = []
    for st in steps_for(box):
        shot = st.get("shot")
        if shot and shot not in src:
            # A beat whose screenshot the tour could not take — no devices
            # declared, no soif installed — is dropped rather than filmed as an
            # empty box. Said out loud, because a quietly shorter reel is a
            # feature that silently stopped being demonstrated.
            print(f"   (skipped: {shot} — no such frame in the capture)")
            continue

        n = max(1, int(FPS * st["hold"]))
        if "card" in st:
            chunks.append([card_frame(st["card"])] * n)
        else:
            im = src[shot]
            crop = st.get("crop")
            to = st.get("to")
            if to:
                # A slow push, for the shots where the eye needs leading somewhere.
                chunks.append([
                    shot_frame(im, lerp_box(crop, to, i / max(1, n - 1)), st["title"], st.get("sub"))
                    for i in range(n)
                ])
            else:
                chunks.append([shot_frame(im, crop, st["title"], st.get("sub"))] * n)
        in_gif.append(bool(st.get("gif")))

    return chunks, in_gif


def assemble(chunks: list[list[Image.Image]]) -> list[Image.Image]:
    """Concatenate chunks, crossfading the joins.

    Held frames are the same object, so this only does real work at the
    boundaries — a two-minute reel is a few dozen distinct images.
    """
    fade = int(FPS * FADE)
    out: list[Image.Image] = []
    for i, chunk in enumerate(chunks):
        if i and fade:
            prev = out[-1]
            for k in range(fade):
                out.append(Image.blend(prev, chunk[0], k / fade))
        out.extend(chunk)
    return out


def write_frames(frames: list[Image.Image], into: pathlib.Path, half: bool = False) -> int:
    if into.exists():
        shutil.rmtree(into)
    into.mkdir(parents=True)
    for k, img in enumerate(frames, 1):
        if half:
            img = img.resize((W // 2, H // 2), Image.LANCZOS)
        img.save(into / f"f{k:05d}.png")
    return len(frames)


def ffmpeg() -> str:
    """ffmpeg, wherever it is. Named rather than assumed, so the failure is clear."""
    found = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not found:
        raise SystemExit("mkdemo: no ffmpeg on PATH — set FFMPEG=/path/to/ffmpeg")
    return found


def run(*args: str) -> None:
    subprocess.run([ffmpeg(), "-y", "-loglevel", "error", *args], check=True)


def encode_mp4(out: pathlib.Path, name: str, frames: pathlib.Path, n: int) -> None:
    mp4 = out / f"{name}.mp4"
    run("-framerate", str(FPS), "-i", str(frames / "f%05d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "21",
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", str(mp4))
    print(f"   {name}.mp4  {mp4.stat().st_size // 1024}KB   ({n} frames, {n / FPS:.1f}s)")


def encode_gif(out: pathlib.Path, name: str, frames: pathlib.Path, n: int) -> None:
    """Two-pass GIF.

    A per-clip palette is the difference between crisp UI text and dithered
    mush. The frames are already half size, and half the frame rate costs
    nothing visible on a reel that is mostly held frames — it halves a file that
    has to load inside a README.
    """
    pal = out / "palette.png"
    gif = out / f"{name}.gif"
    run("-framerate", str(FPS // 2), "-i", str(frames / "f%05d.png"),
        "-vf", "palettegen=max_colors=128:stats_mode=diff", str(pal))
    run("-framerate", str(FPS // 2), "-i", str(frames / "f%05d.png"), "-i", str(pal),
        "-lavfi", "[0:v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
        "-loop", "0", str(gif))
    pal.unlink(missing_ok=True)
    print(f"   {name}.gif  {gif.stat().st_size // 1024}KB   ({n} frames, {n / (FPS // 2):.1f}s)")


def poster(frames_dir: pathlib.Path, out: pathlib.Path, name: str) -> None:
    """The still behind the video before it plays. The board, not the title card.

    A poster is the frame most people will see for longest — on a slow
    connection it may be the only one — so it shows the product rather than the
    word for it.
    """
    entries = json.loads((frames_dir / "manifest.json").read_text())
    board = next((m for m in entries if m["name"] == "board"), entries[0])
    img = Image.open(frames_dir / board["file"]).convert("RGB")
    frame = shot_frame(img, None, "Every session on this machine, on one board",
                       "Read from the registry and the transcripts already on your disk. Nothing is sent anywhere.")
    path = out / f"{name}-poster.jpg"
    frame.save(path, quality=88, optimize=True)
    print(f"   {name}-poster.jpg  {path.stat().st_size // 1024}KB")


if __name__ == "__main__":
    frames_dir = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    chunks, in_gif = render(frames_dir)

    full = assemble(chunks)
    n = write_frames(full, out / "frames")
    encode_mp4(out, "localflow", out / "frames", n)

    # Half the frame rate for the GIF: keep every other frame of the same cut.
    short = assemble([c for c, keep in zip(chunks, in_gif) if keep])[::2]
    gn = write_frames(short, out / "gframes", half=True)
    encode_gif(out, "localflow", out / "gframes", gn)

    poster(frames_dir, out, "localflow")
    shutil.rmtree(out / "frames")
    shutil.rmtree(out / "gframes")
