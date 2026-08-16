# kinocomputing

A stream of notes and shares at [kinocomputing.com](https://kinocomputing.com).

## How it works

The repo root is the source of truth. Each note is a standalone HTML page that
carries everything the build needs:

- `<meta property="article:published_time" content="...">` — an ISO timestamp,
  which decides where the note falls in the stream
- a `<main>` element — the note body, inlined verbatim into the stream
- an empty `<nav class="adjacent"></nav>` — the build fills in prev/next

`tools/build-stream.mjs` reads every `*.html` in the root except `index.html`
and anything prefixed `_`, sorts them newest-first, and writes:

1. `index.html` — the stream, from the `<!-- each:entry -->` block in `_stream.html`
2. the `<nav class="adjacent">` block in each note page, from `_note.html`

Anything that can drop a conforming file into the root joins the stream with
correct neighbours. There is no registry and no ordering to agree on, so
multiple publishers can coexist without coordinating.

A root `*.html` file missing `published_time` or `<main>` is warned about and
skipped rather than ingested — that is the guard against the flat namespace,
since notes are unprefixed at the top level.

## Publishing

Add `NNN-colour-animal.html` to the root and push. The slug numbering is
cosmetic; ordering comes from the timestamp alone.

```
node tools/build-stream.mjs          # rebuild
node tools/build-stream.mjs --check  # exit 1 if anything is stale, write nothing
```

You do not need to run the build before pushing — Cloudflare runs it per-deploy.

## Deployment

Cloudflare Pages, built from a fresh checkout on every push:

| Setting          | Value                        |
| ---------------- | ---------------------------- |
| Framework preset | None                         |
| Build command    | `node tools/build-stream.mjs` |
| Output directory | `/`                          |

Nothing is committed back, so the copies in git keep whatever adjacent nav they
were last written with. Only the deployed output is guaranteed current.
