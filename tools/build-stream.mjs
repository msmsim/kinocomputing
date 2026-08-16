// Builds index.html and the prev/next links in every note page, from the note
// pages themselves.
//
// Every value comes out of the published pages, so there is no registry to keep
// in sync and no ordering to agree on: the repo root is the source of truth.
// Anything that can drop a conforming .html file into it — a publisher, a
// receiver, a hand-written file — joins the stream with correct neighbours.
//
// This runs as the Cloudflare Pages build command, against a fresh checkout, on
// every deploy. Nothing is committed back, so the copies in git keep whatever
// adjacent nav they were last written with; only the deployed output is
// guaranteed current. That is the whole reason there is no workflow here.
//
//   node tools/build-stream.mjs [--check]
//
// --check exits 1 if anything would change, without writing.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The notes sit at the root: a note published as 001-teal-voles.html is served
// at /001-teal-voles, and the stream is the site's front page.
const NOTES_DIR = ".";
const SITE_BASE = "https://kinocomputing.com";
const INDEX_PATH = "/";
const TIME_ZONE = "Europe/London";

const check = process.argv.includes("--check");

/** "3 Aug 2026, 22:49" — the format already on every published page. */
function displayTime(iso) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: TIME_ZONE,
  }).formatToParts(new Date(iso));
  const at = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${at("day")} ${at("month")} ${at("year")}, ${at("hour")}:${at("minute")}`;
}

const between = (html, open, close) => {
  const start = html.indexOf(open);
  if (start === -1) return null;
  const end = html.indexOf(close, start + open.length);
  if (end === -1) return null;
  return { start, end: end + close.length, inner: html.slice(start + open.length, end) };
};

/**
 * A note page reduced to what the stream needs. Returns null for anything that
 * doesn't look like one, so a stray file in the root — which, with the notes
 * unprefixed at the top level, is the likely shape of a mistake — is skipped
 * rather than silently corrupting the index.
 */
function parseNote(slug, html) {
  const published = html.match(
    /<meta property="article:published_time" content="([^"]+)"/
  );
  const main = between(html, "<main>", "</main>");
  if (!published || !main) return null;

  const iso = published[1];
  if (Number.isNaN(new Date(iso).getTime())) return null;

  return {
    slug,
    iso,
    // The stream shows the note body verbatim; the template supplies the stamp.
    content: main.inner.trim(),
    path: `${INDEX_PATH}${slug}`,
  };
}

/** Substitutes {{name}} placeholders. Values are pre-rendered HTML. */
const fill = (template, values) =>
  template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    Object.hasOwn(values, name) ? values[name] : whole);

function renderStream(template, notes) {
  const each = between(template, "<!-- each:entry -->", "<!-- /each:entry -->");
  if (!each) throw new Error("_stream.html has no <!-- each:entry --> block");

  // Each rendered entry is trimmed and rejoined with a single newline: the
  // template's own newlines around the each-block would otherwise leave a blank
  // line between articles.
  const entries = notes.map((note) => fill(each.inner, {
    content: note.content,
    path: note.path,
    datetime_iso: note.iso,
    datetime: displayTime(note.iso),
    slug: note.slug,
  }).trim()).join("\n");

  const shell = template.slice(0, each.start) + entries + template.slice(each.end);

  return fill(shell, {
    index_path: INDEX_PATH,
    index_url: `${SITE_BASE}${INDEX_PATH}`,
    count: String(notes.length),
  });
}

/**
 * Rebuilds one page's adjacent-nav block. The markup comes from _note.html's
 * if:prev / if:next sections rather than being hardcoded here, so the site
 * keeps deciding what those links look like.
 */
function renderAdjacent(noteTemplate, older, newer) {
  const nav = between(noteTemplate, '<nav class="adjacent">', "</nav>");
  if (!nav) throw new Error("_note.html has no <nav class=\"adjacent\"> block");

  // Each if-section is replaced in place, markers included, by its rendered
  // content or nothing. The newlines around it stay put either way, so a note
  // with no neighbour on one side keeps the blank line the template implies.
  const section = (html, name, values) => {
    const block = between(html, `<!-- if:${name} -->`, `<!-- /if:${name} -->`);
    if (!block) return html;
    const rendered = values ? fill(block.inner, values).trim() : "";
    return html.slice(0, block.start) + rendered + html.slice(block.end);
  };

  let inner = section(nav.inner, "prev",
                      older && { prev: older.slug, prev_path: older.path });
  inner = section(inner, "next",
                  newer && { next: newer.slug, next_path: newer.path });

  return `<nav class="adjacent">${inner}</nav>`;
}

/** Replaces the page's adjacent-nav in place, leaving the rest byte-identical. */
function withAdjacent(html, rendered) {
  const nav = between(html, '<nav class="adjacent">', "</nav>");
  if (!nav) return html;
  return html.slice(0, nav.start) + rendered + html.slice(nav.end);
}

const files = (await readdir(NOTES_DIR))
  .filter((name) => name.endsWith(".html"))
  .filter((name) => name !== "index.html" && !name.startsWith("_"));

const pages = new Map();
const notes = [];
for (const file of files) {
  const html = await readFile(join(NOTES_DIR, file), "utf8");
  const note = parseNote(file.replace(/\.html$/, ""), html);
  if (!note) {
    console.warn(`skipped ${file}: no published_time or no <main>`);
    continue;
  }
  pages.set(note.slug, html);
  notes.push(note);
}

// Newest first, as the stream reads. Ties break on slug so the order is total
// and a rerun can't shuffle two notes published in the same second.
notes.sort((a, b) => new Date(b.iso) - new Date(a.iso) || b.slug.localeCompare(a.slug));

const streamTemplate = await readFile(join(NOTES_DIR, "_stream.html"), "utf8");
const noteTemplate = await readFile(join(NOTES_DIR, "_note.html"), "utf8");

const writes = [];

const indexPath = join(NOTES_DIR, "index.html");
const index = renderStream(streamTemplate, notes);
const currentIndex = await readFile(indexPath, "utf8").catch(() => null);
if (index !== currentIndex) writes.push([indexPath, index]);

notes.forEach((note, i) => {
  const html = pages.get(note.slug);
  const updated = withAdjacent(
    html,
    renderAdjacent(noteTemplate, notes[i + 1] ?? null, notes[i - 1] ?? null)
  );
  if (updated !== html) writes.push([join(NOTES_DIR, `${note.slug}.html`), updated]);
});

if (writes.length === 0) {
  console.log(`${notes.length} notes, already up to date`);
  process.exit(0);
}

if (check) {
  console.error(`${writes.length} file(s) would change:`);
  for (const [path] of writes) console.error(`  ${path}`);
  process.exit(1);
}

for (const [path, content] of writes) await writeFile(path, content);
console.log(`${notes.length} notes, wrote ${writes.length} file(s)`);
