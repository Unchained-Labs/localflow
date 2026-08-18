# Adding another agent tool

localflow reads Claude Code natively. Every other tool is wired up by
description rather than by code, in `~/.localflow/sources.json`.

## Why it works this way

The Claude Code reader is a real parser: it knows that usage is re-emitted as a
message streams, that cache writes are billed by TTL, and that the grouping of
`Agent` calls in an assistant message *is* the fan-out graph. All of that was
established by reading actual transcripts on an actual machine and checking the
result against `claude -p --output-format json`, which reports its own cost and
therefore makes an oracle.

None of that is available for Codex CLI, Gemini CLI, Aider, or OpenCode. Writing
scrapers for their formats from memory would produce files that look like
support and are really guesses — and a guess that parses something is worse
than no adapter at all, because it puts a number on the board.

So localflow does not guess the shape. You tell it.

## The file

```json
{
  "sources": [
    {
      "id": "codex",
      "label": "Codex CLI",
      "root": "~/.codex/sessions",
      "match": "\\.jsonl$",
      "fields": {
        "model":     "model",
        "input":     "usage.input_tokens",
        "output":    "usage.output_tokens",
        "cacheRead": "usage.cached_tokens",
        "messageId": "id",
        "timestamp": "created_at",
        "title":     "title",
        "cwd":       "cwd"
      }
    }
  ]
}
```

| Key | Required | What it means |
|---|---|---|
| `id` | yes | Becomes the card's `source`, and the slice key in the metrics view |
| `root` | yes | Directory holding the tool's session files. `~` is expanded |
| `label` | no | Display name. Defaults to `id` |
| `match` | no | Regex a filename must match. Default `\.jsonl$` |
| `recursive` | no | Walk subdirectories. Default true, bounded to six levels |
| `maxAgeDays` | no | Ignore files older than this. Default 30 |
| `limit` | no | Files read per poll, newest first. Default 40 |
| `fields.*` | no | Dotted paths into each JSON line |

Every field is optional. A source with no token fields still produces cards —
with zero usage and `cost unknown` — and the board says why. That is a useful
card. A card with an invented cost is not.

## The one field worth getting right

`fields.messageId`.

Tools that stream a response often re-emit the same `usage` object on every
update. Summing every line inflated output tokens **2.25×** on a real 17MB
Claude Code transcript — the same bug, in a different file format, is waiting in
every streaming tool. Name a field that is stable per message and each one is
counted once.

Leave it out and every line counts. That is correct for a tool that writes one
line per completed call and wrong for one that streams, so the board flags it:

> source "codex" declares no fields.messageId, so every line was counted. If
> this tool re-emits usage while a response streams, the totals are inflated.

## Working out the paths

```sh
head -1 ~/.codex/sessions/<something>.jsonl | python3 -m json.tool
```

Find the model and the token counts in that output, and write their dotted paths
into `fields`. Then restart localflow and check one card against what the tool
itself reports. If they disagree, the field paths are wrong — and you can see
that they are wrong, which is the whole point.

## Prices

Adding a source does not price it. localflow ships verified Anthropic rates and
asserts them in CI; it does not ship anyone else's, because nothing here can
watch their pricing page. Supply them yourself in `~/.localflow/pricing.json`:

```json
{
  "verified": "2026-08-18",
  "models": {
    "gpt-5.2":      { "input": 1.25, "output": 10 },
    "gemini-3-pro": { "input": 2.5,  "output": 15 }
  }
}
```

Rates are USD per million tokens. `verified` is the date you last checked them,
and the board shows how stale that is — a price table with no age on it is
indistinguishable from a correct one.

Until you supply a rate, those cards show tokens and no dollar figure. That is
the honest rendering of "nobody here knows what that cost", and it is the same
rule the Claude cards have always followed: **`cost unknown`, never `$0.00`.**

## Local models are a real zero

A model served from your own hardware — LeHarness on a DGX Spark, Ollama on a
laptop — is priced at **0**, and that zero means something different from the
`null` an unpriced cloud model gets. There is no per-token bill. The bill was
the machine.

Recognised by prefix: `chat`, `fast`, `deepseek-ai/…`, `Qwen/…`,
`meta-llama/…`, `mistralai/…`, `google/gemma…`, `ollama:…`.
