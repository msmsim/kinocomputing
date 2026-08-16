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
3. the `<footer class="masthead">` block in each note page, from `_masthead.html`
4. the derivable `<head>` fields and the back-link in each note page

## Head metadata

`<title>`, `og:title`, `og:url`, `og:type`, `og:site_name`, `twitter:card` and
`rel="canonical"` are pure functions of the slug and the constants at the top of
`tools/build-stream.mjs`, so the build rewrites them on every run and adds any a
page is missing. Renaming the site or moving the domain is a one-line change
there; nothing needs republishing.

Not derivable, so left alone and checked instead — the build warns, never fails,
since a bad description is worse as a blocked deploy than as a line in the log:

- a missing, empty, or disagreeing `description` / `og:description`
- an unfilled `{{placeholder}}` left in the head

`article:published_time` is never touched. It is the input the entire ordering
derives from.

## The masthead

Title and subtitle, in `_masthead.html`. One block of markup serves both
positions — a `<header>` at the top of the stream, a `<footer>` at the foot of
every other page — and CSS decides the rest: the stream banners it, everything
else runs it as one line reading `Kinocomputing: researching …`. The site name
is real text in a `.lead` span, hidden wherever the `<h1>` already says it.

It is rewritten into every page on each build rather than baked in at publish
time, so editing that one file restyles the whole site's framing on the next
deploy with nothing republished — the same bargain `note.css` makes. A page with
no masthead block gets one appended, so a publisher whose template lags still
ends up current.

The subtitle links to `/about`, which is the only route to it.

## Standing pages

Pages that aren't notes — currently just `/about` — live in their own directory
as `<name>/index.html` and are listed in `PAGES` at the top of the build script.

The directory matters. A root-level `about.html` would be scanned as a candidate
note, found to have no `article:published_time`, and skipped with a warning on
every single build; a subdirectory falls out of the scan without special-casing.
Listing it in `PAGES` then gets its head, back-link and masthead maintained by
the build exactly like a note's, so it can't rot through a rename.

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
