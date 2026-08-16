// Builds index.html, and the head and navigation of every note page, from the
// note pages themselves.
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

import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

// The notes sit at the root: a note published as 001-teal-voles.html is served
// at /001-teal-voles, and the stream is the site's front page.
const NOTES_DIR = ".";
const SITE_BASE = "https://kinocomputing.com";
const SITE_NAME = "Kinocomputing";
const INDEX_PATH = "/";
const TIME_ZONE = "Europe/London";

// Cloudflare Pages reads this from the deploy root. It is _-prefixed, so the
// note scan skips it for free.
const REDIRECTS = "_redirects";

// GoatCounter. Pageview counts only — no cookies and no cross-site identifiers,
// which is what keeps the site free of a consent banner. Set to "" to take the
// script back off every page.
const ANALYTICS = "https://kinocomputing.goatcounter.com/count";

// The share card. One image for the whole site: every note shares it until
// there is a reason for any note to have its own.
const OG_IMAGE = "kinocomputing-basic-og.jpg";
const OG_IMAGE_ALT =
  "Kinocomputing — alternative paradigms of computing and intelligence";


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
 * A note may open with a bolded line. That line is the note's title: it is
 * promoted to a heading here, and becomes the page's name in place of the slug.
 * A note that opens with prose has no title and stays named by its slug.
 *
 * The already-promoted form is matched first so a second build reads back the
 * title it wrote rather than concluding the note has lost one. Bold that is
 * only part of a paragraph is left alone — a note beginning with an emphasised
 * clause is prose, not a heading, and guessing wrong there rewrites the note.
 */
function readTitle(content) {
  const patterns = [
    /^<h1 class="title">([\s\S]*?)<\/h1>\s*/,
    /^<p>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>\s*/,
    /^<p>\s*<b>([\s\S]*?)<\/b>\s*<\/p>\s*/,
  ];

  for (const pattern of patterns) {
    const found = content.match(pattern);
    if (!found) continue;
    const title = found[1].trim();
    if (!title) continue;
    const body = content.slice(found[0].length);
    return {
      title,
      content: `<h1 class="title">${title}</h1>${body ? `\n${body}` : ""}`,
    };
  }
  return { title: null, content };
}

/** Tag-free plain text. */
const stripTags = (html) =>
  html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** Tag-free, quote-safe text for a title attribute or a <title> element. */
const asText = (html) => stripTags(html).replace(/"/g, "&quot;");

/**
 * A URL slug from a note's title. Entities are dropped rather than spelled out,
 * apostrophes close up so "don't" gives "dont" and not "don-t", and the result
 * is capped so an unusually long title can't produce an unusable path.
 * Returns "" for a title with nothing slug-worthy in it, which the caller
 * treats as having no title at all.
 */
const slugify = (title) => stripTags(title)
  .replace(/&[a-z]+;|&#\d+;/gi, " ")
  .replace(/['’]/g, "")
  .toLowerCase()
  .normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 60)
  .replace(/-+$/, "");

/**
 * A note page reduced to what the stream needs. Returns null for anything that
 * doesn't look like one, so a stray file in the root — which, with the notes
 * unprefixed at the top level, is the likely shape of a mistake — is skipped
 * rather than silently corrupting the index.
 */
function parseNote(fileSlug, html) {
  const published = html.match(
    /<meta property="article:published_time" content="([^"]+)"/
  );
  const main = between(html, "<main>", "</main>");
  if (!published || !main) return null;

  const iso = published[1];
  if (Number.isNaN(new Date(iso).getTime())) return null;

  const { title, content } = readTitle(main.inner.trim());

  // slug and path are assigned later: a titled note is published at a path made
  // from its title, which can only be settled once every note is known.
  return {
    fileSlug,
    iso,
    title,
    html,
    // The stream shows the note body verbatim; the template supplies the stamp.
    content,
  };
}

const VOID_ELEMENTS = new Set(["hr", "img", "br", "input", "meta", "link"]);

/**
 * Splits a fragment into its first top-level element and whatever follows.
 * Depth is tracked on the tag itself, so a blockquote wrapping paragraphs comes
 * back whole rather than being cut at the first </p> inside it.
 *
 * Returns null for anything that doesn't start with an element, which the
 * caller treats as "can't summarise this", not as an error.
 */
function firstBlock(html) {
  const open = html.match(/^\s*<([a-z][a-z0-9]*)\b[^>]*>/i);
  if (!open) return null;

  const tag = open[1].toLowerCase();
  if (VOID_ELEMENTS.has(tag)) {
    const end = open.index + open[0].length;
    return { block: html.slice(0, end), rest: html.slice(end) };
  }

  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tags.lastIndex = open.index;

  let depth = 0;
  let match;
  while ((match = tags.exec(html)) !== null) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) {
      const end = match.index + match[0].length;
      return { block: html.slice(0, end), rest: html.slice(end) };
    }
  }
  return null;
}

/**
 * What a note shows in the stream: its title, its opening block, and a way in
 * if there is more. A note that fits in one block shows whole and gets no link
 * — the stream should read as the note itself wherever it can, and only defer
 * to the page when there is genuinely something being held back.
 */
function previewOf(note) {
  const parts = [];
  let rest = note.content;

  if (note.title) {
    const title = firstBlock(rest);
    if (!title) return note.content;
    parts.push(title.block.trim());
    rest = title.rest;
  }

  const opening = firstBlock(rest.trim());
  if (!opening) return note.content;
  parts.push(opening.block.trim());

  if (opening.rest.trim()) {
    parts.push(
      `<p class="more"><a href="${note.path}" target="_self">Read more…</a></p>`
    );
  }
  return parts.join("\n");
}

// Long enough to be a useful search snippet, short enough not to be truncated
// mid-word by someone else's ellipsis.
const DESCRIPTION_LENGTH = 160;

/** Cuts at a word boundary, or mid-word if there isn't a usable one. */
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s.,;:—–-]+$/, "")}…`;
}

/**
 * A description drawn from the note's opening paragraph. Without one a note
 * gets a bare search result and an empty share card, and the opening line is
 * what a description would have said anyway.
 */
function describe(note) {
  let rest = note.content;
  if (note.title) {
    const title = firstBlock(rest);
    if (title) rest = title.rest;
  }
  const opening = firstBlock(rest.trim());
  if (!opening) return "";
  const text = stripTags(opening.block);
  return text ? asText(truncate(text, DESCRIPTION_LENGTH)) : "";
}

/**
 * Fills in whichever of the two description tags is missing or empty. An
 * authored one always wins, and is copied across to the other rather than
 * being left to disagree with a derived one.
 */
function withDescription(html, derived) {
  const read = (pattern) => html.match(pattern)?.[1]?.trim() ?? "";
  const name = /<meta name="description" content="([^"]*)">/;
  const og = /<meta property="og:description" content="([^"]*)">/;

  const value = read(name) || read(og) || derived;
  if (!value) return html;

  let out = html;
  for (const [pattern, tag] of [
    [name, `<meta name="description" content="${value}">`],
    [og, `<meta property="og:description" content="${value}">`],
  ]) {
    const found = out.match(pattern);
    if (found?.[1].trim()) continue;
    if (found) {
      out = out.replace(pattern, () => tag);
      continue;
    }
    const end = out.indexOf("</head>");
    if (end === -1) continue;
    out = `${out.slice(0, end)}    ${tag}\n${out.slice(end)}`;
  }
  return out;
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
    // On its own page a note's title is the h1 and any subheadings hang under
    // it. In the stream every note is one article among many, so the whole set
    // steps down a level and the nesting survives. h6 has nowhere to go and
    // stays put, which is the only case that flattens.
    content: previewOf(note).replace(
      /<(\/?)h([1-5])\b/gi,
      (whole, slash, level) => `<${slash}h${Number(level) + 1}`
    ),
    path: note.path,
    datetime_iso: note.iso,
    datetime: displayTime(note.iso),
    slug: note.slug,
  }).trim()).join("\n");

  let shell = template.slice(0, each.start) + entries + template.slice(each.end);

  const imageTags = imageFields()
    .filter(({ tag }) => tag)
    .map(({ tag }) => `    ${tag}`)
    .join("\n");
  // With no card there is nothing to put on the placeholder's line, so the line
  // goes rather than being filled with emptiness.
  if (!imageTags) shell = shell.replace(/^[ \t]*\{\{image\}\}\n/m, "");

  return fill(shell, {
    index_path: INDEX_PATH,
    index_url: `${SITE_BASE}${INDEX_PATH}`,
    count: String(notes.length),
    stylesheet,
    // The same card the notes get, rendered from the same fields, so the front
    // page can't end up sharing differently from everything on it.
    twitter_card: image ? "summary_large_image" : "summary",
    image: imageTags,
  });
}

/**
 * Rebuilds a page's whole footer: the datestamp on the left, the navigation on
 * the right, on one line. The two used to be separate siblings, which meant no
 * element contained both and nothing could lay them out as a row.
 *
 * All the markup comes from _note.html's if: sections rather than being
 * hardcoded here, so the site keeps deciding what these look like. `note` is
 * null for a standing page, which has no timestamp and so no stamp.
 */
function renderNotefoot(noteTemplate, note, older, newer) {
  const foot = between(noteTemplate, '<footer class="notefoot">', "</footer>");
  if (!foot) throw new Error('_note.html has no <footer class="notefoot"> block');
  const nav = between(foot.inner, '<nav class="adjacent">', "</nav>");
  if (!nav) throw new Error('_note.html has no <nav class="adjacent"> block');

  // Each if-section renders to its content or drops out entirely. Only the
  // sections that survive are joined, so an end of the stream loses its link
  // and the separator that would have led to it in one go.
  const part = (source, name, values) => {
    const block = between(source, `<!-- if:${name} -->`, `<!-- /if:${name} -->`);
    if (!block || !values) return null;
    return fill(block.inner, values).trim();
  };

  const items = [
    part(nav.inner, "home", { index_path: INDEX_PATH }),
    part(nav.inner, "prev", older && { prev: older.slug, prev_path: older.path }),
    part(nav.inner, "next", newer && { next: newer.slug, next_path: newer.path }),
  ].filter(Boolean);

  // The bar is markup rather than a generated ::before on the links: an
  // underline set on an <a> is drawn through everything inside it, so a
  // pseudo-element separator would come out underlined and inside the hit area.
  const separator = '\n<span class="sep">|</span>\n';
  const navHtml = `<nav class="adjacent">\n${items.join(separator)}\n</nav>`;

  // Derived from published_time rather than left as the publisher wrote it, so
  // a change of format or time zone reaches every note that already exists.
  const stamp = part(foot.inner, "stamp", note && {
    path: note.path,
    datetime_iso: note.iso,
    datetime: displayTime(note.iso),
  });

  return `<footer class="notefoot">\n${stamp ? `${stamp}\n` : ""}${navHtml}\n</footer>`;
}

/**
 * Drops a block entirely, markers and trailing newline included. The top-left
 * back link was superseded by "Home" in the note footer, and publishers still
 * emitting one shouldn't leave it stranded at the top of the page.
 */
function removeBlock(html, open, close) {
  const block = between(html, open, close);
  if (!block) return html;
  const end = html[block.end] === "\n" ? block.end + 1 : block.end;
  return html.slice(0, block.start) + html.slice(end);
}

/** Writes the note body back, with any leading bold promoted to a heading. */
function withMain(html, content) {
  const main = between(html, "<main>", "</main>");
  if (!main) return html;
  return `${html.slice(0, main.start)}<main>\n${content}\n</main>${html.slice(main.end)}`;
}

/**
 * Puts the counter script last in the body, on every page the build touches, so
 * a new note is counted without its author having to remember anything.
 *
 * Any tag already present comes out first: the endpoint stays a one-line change
 * here, a page can't end up counting itself twice, and emptying ANALYTICS
 * removes the script from the whole site on the next build rather than leaving
 * it on pages that already have it.
 */
function withAnalytics(html) {
  const out = html.replace(
    /[ \t]*<script[^>]*\bdata-goatcounter\b[\s\S]*?<\/script>\n?/g, ""
  );
  const end = out.lastIndexOf("</body>");
  if (!ANALYTICS || end === -1) return out;

  const tag = `<script data-goatcounter="${ANALYTICS}"\n`
    + `        async src="//gc.zgo.at/count.js"></script>`;
  return `${out.slice(0, end)}${tag}\n${out.slice(end)}`;
}

/**
 * Puts the rebuilt footer back at the end of the body. The old footer and any
 * loose stamp or nav left over from an earlier layout come out first, so the
 * result is the same whether the page was last built by this version or not.
 */
function withNotefoot(html, rendered) {
  let out = removeBlock(html, '<footer class="notefoot">', "</footer>");
  out = removeBlock(out, '<p class="stamp">', "</p>");
  out = removeBlock(out, '<nav class="adjacent">', "</nav>");

  const end = out.lastIndexOf("</body>");
  if (end === -1) return out;
  return `${out.slice(0, end)}${rendered}\n${out.slice(end)}`;
}

/**
 * The head fields that are pure functions of the slug and the site constants.
 * The build owns them because renaming the site or moving the domain otherwise
 * silently strands every note published before the change, and a wrong
 * canonical is the kind of breakage that shows up as duplicate content and
 * broken share cards rather than as an error.
 *
 * Deliberately not here: article:published_time, which is the input the whole
 * ordering derives from, and the descriptions, which are prose about the note
 * and can't be derived. Those are checked instead — see auditHead.
 */
/** A PNG's dimensions, out of the IHDR chunk that always opens the file. */
function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * A JPEG's dimensions, from the frame header. Unlike PNG there is no fixed
 * offset — the header sits after however many metadata segments the encoder
 * wrote — so the segment chain is walked until a start-of-frame turns up.
 */
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;

  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    // Encoders may pad with 0xff before a marker.
    if (bytes[at + 1] === 0xff) { at += 1; continue; }

    const marker = bytes[at + 1];
    // Standalone markers carry no length field to skip over.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
    // Start of scan: the compressed data begins, so there is no header to find.
    if (marker === 0xda) return null;

    // SOF0-SOF15 hold the frame header. DHT, JPG and DAC share the range and
    // are not frame headers, so they are stepped over like anything else.
    if (marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: bytes.readUInt16BE(at + 5),
        width: bytes.readUInt16BE(at + 7),
      };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/**
 * The card's dimensions. Declaring them lets a scraper lay the preview out
 * before it has fetched the image, which is the difference between a card that
 * appears with the link and one that pops in after.
 *
 * Returns null for a format neither reader knows, and the caller then omits the
 * two tags rather than publishing a guess — an unrecognised card should cost
 * the optimisation, not correctness.
 */
const imageSize = (bytes) => pngSize(bytes) ?? jpegSize(bytes);

/**
 * The share-card tags, shared by the notes and the stream so there is one
 * description of the card rather than two that can drift.
 *
 * Every tag is always listed, with a null where the card doesn't supply one, so
 * removing the image — or swapping it for a format whose dimensions can't be
 * read — takes the stale tags out with it. A page left advertising an image
 * that 404s shares worse than one advertising none.
 */
function imageFields() {
  const size = image?.width ? image : null;
  return [
    ["og:image", image?.url],
    ["og:image:width", size && String(size.width)],
    ["og:image:height", size && String(size.height)],
    ["og:image:alt", image && OG_IMAGE_ALT],
  ].map(([property, content]) => ({
    find: new RegExp(`<meta property="${property}" content="[^"]*">`),
    tag: content
      ? `<meta property="${property}" content="${content}">`
      : null,
  }));
}

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
  // A 1200x630 card shown as summary would be cropped to a small square
  // thumbnail, so the card and this value have to change together.
  { find: /<meta name="twitter:card" content="[^"]*">/,
    tag: `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">` },
  { find: /<link rel="canonical" href="[^"]*">/,
    tag: `<link rel="canonical" href="${url}">` },
  { find: /<link rel="stylesheet" href="[^"]*">/,
    tag: `<link rel="stylesheet" href="${stylesheet}">` },
  ...imageFields(),
];

/**
 * Rewrites the derivable head fields, adding any the page is missing and
 * removing any the site no longer has a value for.
 */
function normaliseHead(html, meta) {
  let out = html;
  for (const { find, tag } of headFields(meta)) {
    if (tag === null) {
      // The whole line goes, indentation and newline included, so a dropped tag
      // doesn't leave a blank line behind in the head.
      out = out.replace(new RegExp(`[ \\t]*${find.source}\\n?`), "");
      continue;
    }
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

const files = (await readdir(NOTES_DIR))
  .filter((name) => name.endsWith(".html"))
  .filter((name) => name !== "index.html" && !name.startsWith("_"));

const notes = [];
// Anything in the root that isn't a note still owns its name, so a title can't
// be slugified onto the path of a file the scan decided to leave alone.
const reserved = new Set(["index"]);

for (const file of files) {
  const fileSlug = file.replace(/\.html$/, "");
  const html = await readFile(join(NOTES_DIR, file), "utf8");
  const note = parseNote(fileSlug, html);
  if (!note) {
    console.warn(`skipped ${file}: no published_time or no <main>`);
    reserved.add(fileSlug);
    continue;
  }
  notes.push(note);
}

/**
 * Settles where each note is published.
 *
 * A titled note takes its path from the title; an untitled one keeps the name
 * its publisher gave the file. Untitled notes are placed first so they always
 * hold their own filename — otherwise a new note whose title happened to
 * slugify onto an existing file's name would silently move that note's URL.
 *
 * Resolution runs in filename order rather than publication order so the same
 * set of notes always yields the same set of paths, whatever order the
 * directory is read in.
 */
for (const pass of [(note) => !note.title, (note) => note.title]) {
  for (const note of [...notes].sort((a, b) => a.fileSlug.localeCompare(b.fileSlug))) {
    if (!pass(note) || note.slug) continue;

    let slug = (note.title && slugify(note.title)) || note.fileSlug;
    if (reserved.has(slug)) {
      let n = 2;
      while (reserved.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    reserved.add(slug);
    note.slug = slug;
    note.path = `${INDEX_PATH}${slug}`;
  }
}

// Newest first, as the stream reads. Ties break on slug so the order is total
// and a rerun can't shuffle two notes published in the same second.
notes.sort((a, b) => new Date(b.iso) - new Date(a.iso) || b.slug.localeCompare(a.slug));

const streamTemplate = await readFile(join(NOTES_DIR, "_stream.html"), "utf8");
const noteTemplate = await readFile(join(NOTES_DIR, "_note.html"), "utf8");

// The stylesheet is fingerprinted with its own contents. Every page is rebuilt
// on each deploy anyway, so the cost is nothing, and it means an edit to
// note.css can't be masked by a browser or an edge cache still holding the old
// one — which is otherwise indistinguishable from the edit not working.
const stylesheet = `/note.css?v=${createHash("sha256")
  .update(await readFile(join(NOTES_DIR, "note.css")))
  .digest("hex").slice(0, 8)}`;

// The card, fingerprinted for the same reason and one more: the social
// scrapers cache by URL for days, so a redrawn card at an unchanged URL keeps
// being shared as the old one. og:image must be absolute — the scrapers fetch
// it without a page to resolve against. A missing file is a warning rather than
// a failure; a deploy with no share card is better than no deploy.
const card = await readFile(join(NOTES_DIR, OG_IMAGE)).catch(() => null);
if (!card) console.warn(`${OG_IMAGE}: not found, publishing without a share card`);
const image = card && {
  url: `${SITE_BASE}/${OG_IMAGE}?v=${createHash("sha256")
    .update(card).digest("hex").slice(0, 8)}`,
  ...(imageSize(card) ?? {}),
};

const writes = [];

const indexPath = join(NOTES_DIR, "index.html");
const index = withAnalytics(renderStream(streamTemplate, notes));
const currentIndex = await readFile(indexPath, "utf8").catch(() => null);
if (index !== currentIndex) writes.push([indexPath, index]);

const renames = [];

notes.forEach((note, i) => {
  const { html } = note;

  let updated = normaliseHead(html, {
    // A titled note is named by its title; an untitled one falls back to the
    // slug, which is the only other name it has.
    title: note.title ? asText(note.title) : note.slug,
    url: `${SITE_BASE}${note.path}`,
    type: "article",
  });
  updated = withDescription(updated, describe(note));
  updated = withMain(updated, note.content);
  updated = removeBlock(updated, '<nav class="back">', "</nav>");
  updated = removeBlock(updated, '<footer class="masthead">', "</footer>");
  updated = withNotefoot(updated, renderNotefoot(
    noteTemplate, note, notes[i + 1] ?? null, notes[i - 1] ?? null
  ));
  updated = withAnalytics(updated);

  // Audited after the rewrites, so it reports what actually ships rather than
  // what the publisher happened to hand over.
  auditHead(updated, note.slug);

  const target = join(NOTES_DIR, `${note.slug}.html`);
  if (note.slug !== note.fileSlug) {
    renames.push([join(NOTES_DIR, `${note.fileSlug}.html`), note.fileSlug, note.slug]);
    writes.push([target, updated]);
  } else if (updated !== html) {
    writes.push([target, updated]);
  }
});


/**
 * Records where a note used to live, so a URL that has ever been published
 * keeps working after a retitle moves it.
 *
 * Entries are only ever added. The build can see a rename exactly once — on the
 * run that performs it — and after that the old filename is gone, so anything
 * dropped here is lost for good. Accumulating a little dead config is the far
 * cheaper mistake.
 */
async function renderRedirects(pairs) {
  const existing = await readFile(join(NOTES_DIR, REDIRECTS), "utf8").catch(() => "");
  const lines = new Set(
    existing.split("\n").map((line) => line.trim()).filter(Boolean)
  );
  for (const [, from, to] of pairs) {
    lines.add(`${INDEX_PATH}${from} ${INDEX_PATH}${to} 301`);
  }
  return `${[...lines].sort().join("\n")}\n`;
}

if (renames.length > 0) {
  const redirectsPath = join(NOTES_DIR, REDIRECTS);
  const redirects = await renderRedirects(renames);
  const current = await readFile(redirectsPath, "utf8").catch(() => null);
  if (redirects !== current) writes.push([redirectsPath, redirects]);
}

if (writes.length === 0 && renames.length === 0) {
  console.log(`${notes.length} notes, already up to date`);
  process.exit(0);
}

if (check) {
  console.error(`${writes.length} file(s) would change:`);
  for (const [path] of writes) console.error(`  ${path}`);
  for (const [path, from, to] of renames) {
    console.error(`  ${path} -> ${to}.html (redirect from ${INDEX_PATH}${from})`);
  }
  process.exit(1);
}

for (const [path, content] of writes) await writeFile(path, content);
// Only after the replacement is safely on disk, so an interrupted build leaves
// a duplicate rather than a hole.
for (const [path] of renames) await unlink(path);

const moved = renames.length ? `, moved ${renames.length}` : "";
console.log(`${notes.length} notes, wrote ${writes.length} file(s)${moved}`);
