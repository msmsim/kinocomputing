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

1. `index.html` — the stream, from the `<!-- each:entry -->` block in `_stream.html`, each note summarised to its title and opening block
2. the `<footer class="notefoot">` block in each note page, from `_note.html`
3. the derivable `<head>` fields in each note page

The footer is one line: datestamp left, navigation right. The nav is the only
navigation a page carries — there is no separate back link — and reads
`↑ Home | ← Previous | → Next`. Any of the three may be absent, so each
separator is emitted with the link it leads to rather than assumed; a standing
page has no neighbours and renders down to just `↑ Home`.

The datestamp is rebuilt from `article:published_time` rather than left as the
publisher wrote it, so a change of format or time zone reaches notes that
already exist. The footer is torn down and re-emitted whole on each build, and a
page still carrying the older loose-sibling layout is migrated in the process.

## The stream

Each note appears as its title plus its opening block. If anything follows,
a `Read more…` link to the note is appended; if nothing does, the note shows
whole and gets no link. That is what keeps the title itself from having to be a
link — the stream reads as the notes wherever it can, and only defers to the
page when it is genuinely holding something back.

"Opening block" means the first top-level element, with depth tracked on the tag
itself, so a note that opens with a blockquote or a list comes back whole rather
than being cut at the first `</p>` inside it.

## Note titles

A note may open with a bolded line on its own — `<p><strong>…</strong></p>`.
That line is the note's title: the build promotes it to `<h1 class="title">` on
the note's own page, steps it down to `<h2>` in the stream where the note is one
article among many, and names the page by it in `<title>` and `og:title` in
place of the slug. A note that opens with prose has no title and is named by its
slug, exactly as before.

Bold that is only part of a paragraph is left alone. A note beginning with an
emphasised clause is prose, not a heading, and guessing wrong there would
rewrite the note's first line.

### The URL follows the title

A titled note is published at a path made from its title — `<p><strong>Notes
can have titles</strong></p>` becomes `/notes-can-have-titles` — and **the build
renames the file on disk to match**. An untitled note keeps the name its
publisher gave it.

Rules, in order:

- Untitled notes are placed first, so they always keep their own filename. A new
  note whose title happened to slugify onto an existing file's name would
  otherwise silently move that note's URL.
- Names already taken get `-2`, `-3` appended — including `index` and the
  `PAGES` paths, and the name of any root file the scan skipped.
- A title with nothing slug-worthy in it falls back to the filename.
- Resolution runs in filename order, so the same notes always yield the same
  paths whatever order the directory is read in.

### Redirects

Renaming breaks any URL already shared, so every rename is recorded in
`_redirects`, which Cloudflare Pages reads from the deploy root. Entries are
**only ever added**: the build can see a rename exactly once, on the run that
performs it, so a dropped entry is gone for good. Retitling twice leaves both
hops, and browsers follow the chain.

Renames happen on disk, which matters locally: running the build in your working
tree moves files. In CI it is harmless — the checkout is thrown away — but a
local run is a real rename, so commit before running it if you want the
publisher's filenames back.

## Head metadata

`<title>`, `og:title`, `og:url`, `og:type`, `og:site_name`, `twitter:card`,
`rel="canonical"` and the stylesheet link are all derived from the note and the
constants at the top of `tools/build-stream.mjs`, so the build rewrites them on
every run and adds any a page is missing. Renaming the site or moving the domain
is a one-line change there; nothing needs republishing.

The stylesheet is fingerprinted with a hash of its own contents —
`/note.css?v=0b5519bc` — so an edit to `note.css` can't be masked by a browser
or edge cache still serving the old one, which is otherwise indistinguishable
from the edit not having worked.

`description` and `og:description` are filled from the note's opening paragraph
when absent or empty, trimmed to 160 characters at a word boundary. An authored
description always wins and is copied across to the other tag rather than left
to disagree with a derived one. So a hand-written note needs nothing but a
timestamp and a `<main>`.

What is left is checked rather than fixed — the build warns, never fails, since
a bad description is worse as a blocked deploy than as a line in the log:

- a `description` / `og:description` that still disagree
- an unfilled `{{placeholder}}` left in the head

The audit runs on the finished page, so it reports what actually ships rather
than what the publisher handed over.

`article:published_time` is never touched. It is the input the entire ordering
derives from.

## The masthead

There isn't one, for now. The site title, subtitle and page footers were removed
deliberately; pages carry their content, their datestamp and their nav, nothing
else. `_masthead.html` is left in the repo unused — it is `_`-prefixed, so the
build skips it and it is never served — and holds the wording if it comes back.

Nothing currently links to `/about`. It is reachable only by typing the URL.

## Standing pages

There aren't any. `/about` is a note like any other — the oldest one, so it sits
at the foot of the stream — which is why it has a timestamp and neighbours. Its
title is "About", so the slug it derives is `about` and the URL is unchanged.

If a page ever genuinely can't be a note, the pattern that worked was a
`<name>/index.html` in its own directory, listed in a `PAGES` constant so the
build maintained its head and nav. A root-level `about.html` without a timestamp
would instead be scanned as a candidate note and skipped with a warning on every
build. That machinery is in the git history rather than the tree.

Anything that can drop a conforming file into the root joins the stream with
correct neighbours. There is no registry and no ordering to agree on, so
multiple publishers can coexist without coordinating.

A root `*.html` file missing `published_time` or `<main>` is warned about and
skipped rather than ingested — that is the guard against the flat namespace,
since notes are unprefixed at the top level.

## Publishing

Add `NNN-colour-animal.html` to the root and push. The numbering is cosmetic;
ordering comes from the timestamp alone, and a note that opens with a bolded
line is republished at a path made from that line instead.

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
