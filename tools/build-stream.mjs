// Builds index.html, and the prev/next links and masthead in every note page,
// from the note pages themselves.
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
const SITE_NAME = "Kinocomputing";
const INDEX_PATH = "/";
const TIME_ZONE = "Europe/London";

// The stream carries the masthead in a <header> at the top and a note carries
// it in a <footer> at the bottom; same markup, different landmark, so the CSS
// can tell the two positions apart.
const MASTHEAD_OPEN = '<footer class="masthead">';
const MASTHEAD_CLOSE = "</footer>";

// Hand-written pages that aren't notes. Kept in their own directory so the root
// scan doesn't have to know about them, and listed here so their head and
// masthead are maintained by the build rather than left to rot.
const PAGES = [
  { file: join("about", "index.html"), path: "/about", title: "About" },
];

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
    masthead,
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

/**
 * Replaces one delimited block in place, leaving the rest of the page
 * byte-identical. Returns the page unchanged if the block isn't there, so a
 * note that predates a block simply doesn't get one rather than failing.
 */
function replaceBlock(html, open, close, rendered) {
  const block = between(html, open, close);
  if (!block) return html;
  return html.slice(0, block.start) + rendered + html.slice(block.end);
}

/**
 * The head fields that are pure functions of the slug and the site constants.
 * The build owns them for the same reason it owns the masthead: renaming the
 * site or moving the domain otherwise silently strands every note published
 * before the change, and a wrong canonical is the kind of breakage that shows
 * up as duplicate content and broken share cards rather than as an error.
 *
 * Deliberately not here: article:published_time, which is the input the whole
 * ordering derives from, and the descriptions, which are prose about the note
 * and can't be derived. Those are checked instead — see auditHead.
 */
const headFields = ({ title, url, type }) => [
  { find: /<title>[^<]*<\/title>/,
    tag: `<title>${title} | ${SITE_NAME}</title>` },
  { find: /<meta property="og:title" content="[^"]*">/,
    tag: `<meta property="og:title" content="${title}">` },
  { find: /<meta property="og:url" content="[^"]*">/,
    tag: `<meta property="og:url" content="${url}">` },
  { find: /<meta property="og:type" content="[^"]*">/,
    tag: `<meta property="og:type" content="${type}">` },
  { find: /<meta property="og:site_name" content="[^"]*">/,
    tag: `<meta property="og:site_name" content="${SITE_NAME}">` },
  { find: /<meta name="twitter:card" content="[^"]*">/,
    tag: `<meta name="twitter:card" content="summary">` },
  { find: /<link rel="canonical" href="[^"]*">/,
    tag: `<link rel="canonical" href="${url}">` },
];

/** Rewrites the derivable head fields, adding any the page is missing. */
function normaliseHead(html, meta) {
  let out = html;
  for (const { find, tag } of headFields(meta)) {
    if (find.test(out)) {
      out = out.replace(find, () => tag);
      continue;
    }
    const end = out.indexOf("</head>");
    if (end === -1) return out;
    out = `${out.slice(0, end)}    ${tag}\n${out.slice(end)}`;
  }
  return out;
}

/**
 * Warns about head metadata the build can't derive and therefore can't fix. A
 * note still publishes with any of these wrong — a missing description is worse
 * as a failed deploy than as a line in the build log — so these never throw.
 */
function auditHead(html, slug) {
  const value = (re) => html.match(re)?.[1];
  const description = value(/<meta name="description" content="([^"]*)"/);
  const ogDescription = value(/<meta property="og:description" content="([^"]*)"/);

  const say = (message) => console.warn(`${slug}: ${message}`);

  if (description === undefined) say("no meta description");
  else if (!description.trim()) say("empty meta description");
  if (ogDescription === undefined) say("no og:description");

  if (description !== undefined && ogDescription !== undefined
      && description !== ogDescription) {
    say("meta description and og:description disagree");
  }
  // An unfilled template placeholder reads as plausible prose in the markup and
  // only looks wrong once it is someone's search result.
  if (/\{\{\w+\}\}/.test(html.slice(0, html.indexOf("</head>")))) {
    say("unfilled {{placeholder}} in head");
  }
}

/**
 * The masthead is the one thing on a note page that isn't about that note, so
 * it is rewritten from _masthead.html on every build rather than baked in at
 * publish time. Editing the partial restyles the whole site's framing on the
 * next deploy with nothing republished — the same bargain note.css makes.
 *
 * A note missing the block entirely gets one appended, so a publisher whose
 * template lags behind still ends up with the current masthead.
 */
function withMasthead(html, rendered) {
  if (between(html, MASTHEAD_OPEN, MASTHEAD_CLOSE)) {
    return replaceBlock(html, MASTHEAD_OPEN, MASTHEAD_CLOSE, rendered);
  }
  const end = html.lastIndexOf("</body>");
  if (end === -1) return html;
  return html.slice(0, end) + rendered + "\n" + html.slice(end);
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
const masthead = (await readFile(join(NOTES_DIR, "_masthead.html"), "utf8")).trim();

// Same content top and bottom; only the wrapping landmark differs.
const noteMasthead = `${MASTHEAD_OPEN}\n${masthead}\n${MASTHEAD_CLOSE}`;

const writes = [];

const indexPath = join(NOTES_DIR, "index.html");
const index = renderStream(streamTemplate, notes);
const currentIndex = await readFile(indexPath, "utf8").catch(() => null);
if (index !== currentIndex) writes.push([indexPath, index]);

const backNav =
  `<nav class="back"><a href="${INDEX_PATH}" target="_self">← ${SITE_NAME}</a></nav>`;

notes.forEach((note, i) => {
  const html = pages.get(note.slug);
  auditHead(html, note.slug);

  let updated = normaliseHead(html, {
    title: note.slug, url: `${SITE_BASE}${note.path}`, type: "article",
  });
  updated = replaceBlock(updated, '<nav class="back">', "</nav>", backNav);
  updated = replaceBlock(
    updated, '<nav class="adjacent">', "</nav>",
    renderAdjacent(noteTemplate, notes[i + 1] ?? null, notes[i - 1] ?? null)
  );
  updated = withMasthead(updated, noteMasthead);

  if (updated !== html) writes.push([join(NOTES_DIR, `${note.slug}.html`), updated]);
});

// Standing pages get the same head, back-link and masthead as a note. They have
// no timestamp and no place in the stream, so they live in their own directory
// rather than the root, which is also what keeps them out of the scan above
// instead of being skipped with a warning on every build.
for (const page of PAGES) {
  const file = join(NOTES_DIR, page.file);
  const html = await readFile(file, "utf8").catch(() => null);
  if (html === null) {
    console.warn(`skipped ${page.file}: not found`);
    continue;
  }
  auditHead(html, page.file);

  let updated = normaliseHead(html, {
    title: page.title, url: `${SITE_BASE}${page.path}`, type: "website",
  });
  updated = replaceBlock(updated, '<nav class="back">', "</nav>", backNav);
  updated = withMasthead(updated, noteMasthead);

  if (updated !== html) writes.push([file, updated]);
}

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
