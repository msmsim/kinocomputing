# kinocomputing

A stream of notes and shares at [kinocomputing.com](https://www.kinocomputing.com).

## How it works

`notes/` is the source of truth and `dist/` is the deploy. Each note is a
standalone HTML page in `notes/` that carries everything the build needs:

- `<meta property="article:published_time" content="...">` — an ISO timestamp,
  which decides where the note falls in the stream
- a `<main>` element — the note body, inlined verbatim into the stream
- an empty `<nav class="adjacent"></nav>` — the build fills in prev/next

`tools/build-stream.mjs` reads every `*.html` in `notes/` except `index.html`
and anything prefixed `_`, sorts them newest-first, and writes `dist/`:

1. `index.html` — the stream, from the `<!-- each:entry -->` block in `_stream.html`, each note summarised to its title and opening block
2. one page per note, its `<footer class="notefoot">` built from `_note.html` and its derivable `<head>` fields filled in
3. `_redirects`, and the assets — `note.css`, the share card
4. the [blyg](docs/blyg.md) surface — `blyg.json`, `feed.xml`, `items/` —
   copied from `blyg/`, plus each note's version markers and discovery links,
   frozen pages for pinned versions, and tombstones for withdrawn notes

Nothing under `notes/` is ever written to. The build only reads it, so a note
stays exactly as its publisher wrote it however many times the site is built,
and `dist/` is rebuilt from empty each time rather than patched — it can only
hold what the last run produced.

The two directories exist because motes addresses a repo path and a URL path
with one setting and can't be told they differ. Reading from one place and
writing to another reconciles that, and pays for itself twice over: the sources
are never modified, and the tooling and README are no longer part of the site.

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

## The menu and the tracker

Everything the site publishes is a note — a thread or a fragment, in the one
stream and the one feed (`feed.xml`). Every page carries a small menu under
the mark (the stream under its subtitle): **Notes** (the stream itself),
**Tracker**, **Reading** and **About**, with where you are marked.

The **Tracker** is the one page with a layout of its own, in the notes' own
column: a table per group of every paradigm the lab follows, whether or not
it has an entry yet, with where it stands — its entry's "Where it stands"
paragraph in full, links and all, or its whole lead — and when the lab last
looked. It is built from `notes/_tracker.json`, which the lab writes
every night, and from the notes that are its entries: those whose page says
so (`<meta name="kino:section" content="tracker">`, from the lab's publisher)
or whose name marks them as a paradigm entry. It is presentation, not a blyg
item, and has no feed of its own; its entries are in the main feed. Tables
scroll in their own box on a phone rather than widening the page. It is in
the sitemap and llms.txt, with a `CollectionPage` listing its entries.

An earlier version had pages and feeds for Notes, Lab, Audits and Briefs;
their addresses redirect home and to `feed.xml`.

## Reading

The lab's reading list, and the site's one **hopper** (spec 0.4 §6.1): every
link Matt shares to the lab from Subset, and every source the lab itself
found worth keeping, each with one line from the lab on what it is and why
it matters, its paradigms, and the notes that used it. Newest first, with a
filter by words and by paradigm. The filter is the site's only script; the
page is complete without it, and the form stays hidden until the script
shows it.

It is built from `notes/_hopper.json`, which the lab writes every night from
its `state/hopper.jsonl`, and it is presentation, not blyg items: the links
are other people's pages. Its feed, `feeds/reading.xml`, is plain RSS of the
links, declared in `blyg.json` as the hopper's feed. The site's notes feed
stays the one feed of notes.

Subset's receiver for the lab tells Subset that a share lives at
`/reading/<share>`; `_redirects` sends any such address to
`/reading#<share>`, its row on the page (or the top of it, until the lab has
weighed the share).

## Maths

Write TeX between dollars — `$e^{i\pi}+1=0$` inline, `$$…$$` on a line of its
own for a displayed formula — following pandoc's `tex_math_dollars`, as the
blyg reference client does: an opening `$` must be followed by a non-space,
and a closing one must follow a non-space and not be followed by a digit, so
"$5 and $10" stays prices; `\$` is a dollar; code is left alone.

The build draws each formula as MathML Core with the TeX kept in an
`application/x-tex` annotation (spec 0.4 §5.2), using temml, server-side: no
script, stylesheet or font goes with the page, and a reader that won't draw
MathML can show the TeX. The blyg item's markdown carries the TeX as written;
a formula without its annotation is refused. temml is vendored in
`tools/vendor/` so nothing needs installing: the blyg state Action and
Cloudflare Pages build from a bare checkout, and the lab's publisher uses the
same `tools/maths.mjs`. Maths in your own posts works if motes passes the
dollars through untouched.

## Previews

The stream shows each note's title and its lead, and the description (search
results, share cards, llms.txt) is drawn from the same lead. A paragraph
that only labels — wholly in italics, like a voice's byline, or wholly in
bold, like a brief's "First shift" — is passed over in both, so a preview
always opens with something the note says.

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
can have titles</strong></p>` becomes `/notes-can-have-titles`. The source file
keeps whatever name it was given; only the published page is named by the title.
An untitled note is published under its filename.

Rules, in order:

- Untitled notes are placed first, so they always keep their own filename. A new
  note whose title happened to slugify onto an existing file's name would
  otherwise silently move that note's URL.
- Names already taken get `-2`, `-3` appended — including `index`, the asset
  names, and the name of any file in `notes/` the scan skipped.
- A title with nothing slug-worthy in it falls back to the filename.
- Resolution runs in filename order, so the same notes always yield the same
  paths whatever order the directory is read in.

### Redirects

`dist/_redirects`, which Cloudflare Pages reads from the deploy root, keeps
every URL a note has been reachable at pointing at the note. Two rules per note
are derived:

- `/<file name>` → the note, so a note published before it was titled — or
  retitled since — is still reachable at the URL it went out with
- `/notes/<file name>` → the note, because motes writes internal links in that
  form. They arrive inside the note body, which the build passes through
  untouched, so they are met with a redirect rather than rewritten

Both are re-derived on every build. Source filenames never change, so unlike a
build that renames in place, nothing has to be remembered between runs and
there is no entry that can be lost by pruning. A `_redirects` at the repo root
is optional and is folded in first, for anything the build can't know about —
a URL from a previous site, say.

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
(and the next ones, while it is under 50 characters; a byline in italics is
skipped), trimmed to 160 characters at a word boundary. An authored description
wins when search results can use it — 50 to 165 characters, and not just the
title again, which is what motes writes for a titled note — and is copied
across to the other tag. So a hand-written note needs nothing but a timestamp
and a `<main>`.

`<title>` is "<title> | Kinocomputing" when that fits in 65 characters, where
search results cut titles off, and the title alone when it doesn't.

### Agent readiness

What search engines and AI assistants read without guessing, all derived at
every build, so a new note is covered the moment it is published:

- **Structured data** (JSON-LD) in every note's head: a `BlogPosting` (the
  About page an `AboutPage`) with its headline, description, first and latest
  version dates and version number, written by the PI or, for the lab's notes,
  by the lab (with the model named), published by the project. The stream
  carries the site graph: the `WebSite`, the project as a `ResearchProject`, its
  founder, and the lab.
- **`sitemap.xml`**: the stream and every live note, with when each last
  changed. Not withdrawn notes, not frozen versions (they are canonical to the
  live page).
- **`llms.txt`** ([llmstxt.org](https://llmstxt.org)): what the site is, the
  pages to start with, the machine-readable surface (blyg, feed, sitemap, the
  lab's repository), the paradigm tracker's entries and the latest notes.
- **`/.well-known/security.txt`** (RFC 9116): contact via the About page,
  expiring 11 months from the month it was built, so it never lapses while
  the site keeps building.
- **`robots.txt`**, the site's own policy, versioned here (Cloudflare's
  managed robots.txt is off, and so is its "Block AI bots" firewall rule,
  which would otherwise override this file). The site sells nothing and
  exists to be read, so the assistants' named crawlers are welcome for
  search, live answers and training alike (GPTBot, OAI-SearchBot,
  ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, Google-Extended,
  Applebot-Extended, PerplexityBot…: none is named, so all may read), with a
  content signal saying so. Refused: scrapers that resell, monitor or
  harvest and bring no readers (`CRAWLERS_REFUSED` in the build). It names
  the sitemap.
  Cloudflare's edge still refuses ClaudeBot, anthropic-ai and PerplexityBot by
  name (checked 23 November 2026; the per-crawler setting couldn't be found
  in the dashboard). Claude's search and user-fetch agents (Claude-SearchBot,
  Claude-User) get through, so Claude can still find and cite the site; only
  Anthropic's training crawler is kept out.

The blyg was already most of what an agent needs: every note as JSON, with its
versions, at a stable address.

### The share card

`kinocomputing-basic-og.jpg` is the card for the whole site — every note shares
it until one has a reason of its own. The build emits `og:image` as an absolute
URL (scrapers fetch it with no page to resolve against), reads `og:image:width`
and `og:image:height` out of the image's own header so a preview can be laid out
before the image arrives, and sets `twitter:card` to `summary_large_image`,
since a 1200×630 card sent as `summary` is cropped to a square thumbnail.

It is a JPEG rather than a PNG, and deliberately kept small: WhatsApp only
generates a preview for cards under roughly 300KB, so a lossless 1.6MB gradient
silently got no card there at all. Both PNG and JPEG headers are read, so the
format can change back without losing the dimensions.

The card is fingerprinted like the stylesheet, and for one more reason: the
social scrapers cache by URL for days, so a redrawn card at an unchanged URL
goes on being shared as the old one.

Every image tag is emitted or removed on each build. Delete the card and the
tags go with it and `twitter:card` falls back to `summary`; swap it for a format
whose dimensions can't be read and only the width and height drop. A missing
card is a warning, never a failure — a deploy with no share card beats no
deploy.

What is left is checked rather than fixed — the build warns, never fails, since
a bad description is worse as a blocked deploy than as a line in the log:

- a `description` / `og:description` that still disagree
- a description outside 50–165 characters, or a title over 65 even without
  the site's name: words only the author can change
- no structured data
- an unfilled `{{placeholder}}` left in the head

The audit runs on the finished page, so it reports what actually ships rather
than what the publisher handed over.

`article:published_time` is never touched. It is the input the entire ordering
derives from.

## Analytics

GoatCounter, from the `ANALYTICS` constant in `tools/build-stream.mjs`. The
build puts the script last in the body of the stream and of every note, so a
new note is counted without its author having to remember anything.

Any tag already on a page is replaced rather than joined, so the endpoint is a
one-line change and a page can't count itself twice. Setting `ANALYTICS` to `""`
takes the script off the whole site on the next build rather than leaving it on
the pages that already had it. Scripts that aren't GoatCounter's are left alone.

It counts pageviews with no cookies and no cross-site identifiers, which is what
keeps the site free of a consent banner.

## The masthead

The stream opens with one: □◇, the site's name, the subtitle under it, and
the blyg and RSS links to the right. It is the stream's alone — note pages
carry their content, their datestamp and their nav, and their "↑ Home" is the
way back to it.

Every page the build writes — the stream, notes, frozen versions, tombstones —
ends with the site footer: the name linking home, the subtitle, and the author.
It is built from the blyg's own values (`BLYG` in `tools/build-stream.mjs`), so
the footer, the manifest and the feed can't disagree. The subtitle is also the
stream's description in `_stream.html`; change the two together.

## Icons

`favicon.svg` is the mark, □◇ — "always eventually", liveness in temporal
logic — on the site's colour. `favicon.ico` (32px) and `apple-touch-icon.png`
(180px, square, since phones round it themselves) are rendered from it and
committed; redraw the SVG and regenerate both. Every page links all three, and
the two raster ones sit at the addresses anything asks for by default.

Nothing currently links to `/about`. It is reachable only by typing the URL.

## Standing pages

There aren't any. `/about` is a note like any other — the oldest one, so it sits
at the foot of the stream — which is why it has a timestamp and neighbours. Its
title is "About", so the slug it derives is `about` and the URL is unchanged.

If a page ever genuinely can't be a note, the pattern that worked was a
`<name>/index.html` in its own directory, listed in a `PAGES` constant so the
build maintained its head and nav. That machinery is in the git history rather
than the tree.

Anything that can drop a conforming file into `notes/` joins the stream with
correct neighbours. There is no registry and no ordering to agree on, so
multiple publishers can coexist without coordinating.

A file in `notes/` missing `published_time` or `<main>` is warned about and
skipped rather than ingested — that is the guard against the flat namespace,
since notes share one directory with no prefix.

## Publishing from motes

[motes](https://github.com/msmsim/motes) publishes to this repo directly. Vault
settings:

| setting | value |
| ------- | ----- |
| base url | `https://www.kinocomputing.com` |
| owner / repo | `msmsim` / `kinocomputing` |
| notes folder | `notes` |

The folder has to be `notes` rather than the site root: motes uses that one
setting as both the repo path it commits to and the URL path it links to, so an
empty value would build `//` into every path. That is the whole reason the
sources live in a directory of their own — the build reconciles the two by
reading `notes/` and publishing to `/`.

Consequences worth knowing:

- motes writes only `notes/<slug>.html`. The stream is this build's alone, so
  `_stream.html` is never applied by the app and can use values motes doesn't
  supply.
- The templates are at `notes/_note.html` and `notes/_stream.html`, which is
  where motes looks for them.
- motes drops `<!-- if:stamp -->` and `<!-- if:home -->` when it renders a note,
  since it supplies no such values. The build rebuilds the footer whole on every
  deploy and puts both back.
- A note is titleless to motes, but its markdown renderer emits
  `<p><strong>…</strong></p>` for a lone bolded line — which is exactly what
  this build promotes to a title. Bold first lines work from the phone.
- Deleting a note in motes removes `notes/<slug>.html` by its original name, so
  a retitled note is still taken down correctly; the build never renames the
  file it addresses. On the blyg that delete is a withdrawal: a tombstone stays
  at the address, and pinned versions stay up.
- The vault can be marked as a blyg in motes. `_note.html` opts in to its pin
  and change-note requests, which the Action reads (docs/blyg.md).

## Publishing from the lab

The [Kinocomputing lab](https://github.com/msmsim/kinocomputing-lab), an
automated research agent, publishes here too: notes named `lab-YYYY-MM-DD-…`,
pushed after its night shift. Each page carries
`<meta name="blyg:generated" content="<model>">`, which the build turns into
§5.7 provenance on the blyg item and the `blyg-tk-gen` wrapper in its
`content_html` (docs/blyg.md, P20). The pages carry no per-note line; the
site footer says what the whole site is. The lab only ever writes notes
with its own names.

The lab's claims are short fragments, and its write-ups are threads
(`<meta name="blyg:kind" content="thread">`) that quote them — and quote your
notes, which are fragments — with `<blockquote class="kino-quote"
data-note="<file>">`. The build bakes each quote as a §10 transclusion: a
snapshot at the version quoted, which stays put when the claim moves on, so a
thread quoting an old stage of a claim reads as stale until the lab
republishes it (docs/blyg.md, P21–P22). Your posts here are how you steer the
lab: anything on kinocomputing it didn't write is yours, and its next shift
reads it.

## Publishing by hand

Add `NNN-colour-animal.html` to `notes/` and push. The numbering is cosmetic;
ordering comes from the timestamp alone, and a note that opens with a bolded
line is published at a path made from that line instead.

```
node tools/build-stream.mjs          # rebuild
node tools/build-stream.mjs --check  # exit 1 if anything is stale, write nothing
npm test                             # unit tests and the blyg oracles
```

You do not need to run the build before pushing — Cloudflare runs it per-deploy,
and the Action keeps the blyg state. Don't run `--state` and commit its output
by hand on a branch: ids it assigns are permanent once they reach main.

## Deployment

Cloudflare Pages, built from a fresh checkout on every push:

| Setting          | Value                        |
| ---------------- | ---------------------------- |
| Framework preset | None                         |
| Build command    | `node tools/build-stream.mjs` |
| Output directory | `dist`                       |

The build also writes `404.html`, which Pages serves with a 404 for any address
the site doesn't have. Without it Pages falls back to the stream with a 200, so
a mistyped URL silently showed the home page. No note can take the name.

`dist/` is generated and git-ignored. The repo holds sources; the deploy holds
pages, and only the deploy is ever current.

The one exception is `blyg/`, the blyg's ids, version history and pins, which
can't be derived from the pages. The **Build blyg state** workflow
(`.github/workflows/stream.yml`) is its only writer: on each push to main it
runs `node tools/build-stream.mjs --state` and commits `blyg/` back, and that
commit deploys the surface. A publish therefore deploys twice, the second time
with the blyg caught up. **Send mentions** (`mentions.yml`) announces stubs of
other blygs by Webmention; it is a dry run until the repository variable
`MENTIONS_LIVE` is `true`. See [docs/blyg.md](docs/blyg.md).
