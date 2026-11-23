// Builds index.html, and the head and navigation of every note page, from the
// note pages themselves.
//
// Every value comes out of the published pages, so there is no registry to keep
// in sync and no ordering to agree on: the repo root is the source of truth.
// Anything that can drop a conforming .html file into it — a publisher, a
// receiver, a hand-written file — joins the stream with correct neighbours.
//
// The one thing that can't be derived is each note's Blygger identity and
// version history (docs/blyg.md). That lives in blyg/, with the protocol
// surface built from it, and has exactly one writer: this build run with
// --state, by the Action on main, which commits blyg/ back. Every other run —
// Cloudflare's, on every deploy — only reads it.
//
//   node tools/build-stream.mjs [--check]          pages into dist/
//   node tools/build-stream.mjs --state [--check]  registry and surface into blyg/
//
// --check exits 1 if anything would change, without writing.
// --allow-mass-withdrawal lets --state withdraw more than MAX_WITHDRAWALS notes.
// BLYG_NOW (an ISO time) stands in for the clock, for tests.

import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  updateRegistry, serializeRegistry, buildSurfaces, buildPins, withHeadLinks, latestTime,
  renderVersions, withVersions, renderWithdrawn, renderPinnedVersions, withPinnedVersions,
  asksForPin, withoutPinRequest, changeNoteOf, withoutChangeNote, pinnedPath,
  withQuotes, bakeQuote, quotesIn,
} from "./blyg.mjs";
import { stubTarget, resolveStub } from "./stub.mjs";

// Notes are published into a folder of their own and served from the site root:
// a note written as notes/001-teal-voles.html is served at /001-teal-voles, and
// the stream is the site's front page.
//
// The folder exists because motes addresses a repo path and a URL path with the
// same setting, and can't be told they differ. Reading from one place and
// writing to another reconciles that, and pays for itself twice over: the
// sources are never modified by a build, and only built pages are deployed —
// the tooling, the README and the templates stay out of the site.
const SOURCE_DIR = "notes";
const OUT_DIR = "dist";
// The host the site is served from. The apex should 301 here (a Cloudflare
// redirect rule: Pages' _redirects can't match on host). This is the blyg's
// identity origin (§12.2), so it is the one every document, feed link and
// canonical URL names; readers that fetched from the apex arrive here.
const SITE_BASE = "https://www.kinocomputing.com";
const SITE_NAME = "Kinocomputing";
const INDEX_PATH = "/";
const TIME_ZONE = "Europe/London";

// Cloudflare Pages reads this from the deploy root. A copy at the repo root is
// optional and seeds the generated one, for rules no build could derive.
const REDIRECTS = "_redirects";

// Copied into the deploy as they are. Everything else at the repo root — the
// build, the README — is tooling, and stays out of the site.
const ASSETS = ["note.css", "favicon.svg", "favicon.ico", "apple-touch-icon.png"];

// GoatCounter. Pageview counts only — no cookies and no cross-site identifiers,
// which is what keeps the site free of a consent banner. Set to "" to take the
// script back off every page.
const ANALYTICS = "https://kinocomputing.goatcounter.com/count";

// The share card. One image for the whole site: every note shares it until
// there is a reason for any note to have its own.
const OG_IMAGE = "kinocomputing-basic-og.jpg";
const OG_IMAGE_ALT =
  "Kinocomputing — alternative paradigms of computing and intelligence";

// The blyg. Its origin is the site root, so the surface (blyg.json, feed.xml,
// items/) is served beside the notes. blyg/ holds that surface as committed,
// plus files prefixed _ — the registry, the mentions log — which are state,
// not surface, and are never deployed.
const STATE_DIR = "blyg";
const REGISTRY = join(STATE_DIR, "_registry.json");
const BLYG = {
  origin: `${SITE_BASE}/`,
  title: SITE_NAME,
  description: "Automated independent research into alternative paradigms of computing and intelligence.",
  author: { name: "Matthew McDowell-Sweet", url: "https://www.msweet.net/" },
  generator: "kinocomputing-build/0.1",
  generatorUrl: "https://github.com/msmsim/kinocomputing",
};
// The site's mark, □◇, as the masthead draws it (notes/_stream.html).
const MARK_SVG = '<svg class="mark" viewBox="2 9.3 28 13.4" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3.6" y="11.4" width="9.2" height="9.2"/><path d="M22.6 10.2 L28.4 16 L22.6 21.8 L16.8 16 Z" stroke-linejoin="round"/></g></svg>';
// The site footer, on every page, one line of parts: the mark and name back to
// the stream, what the site is, who runs it, and how to reach them. Built from
// the same values as the blyg's manifest so the two can't come to disagree.
// The address is written the way the PI wants it, not as a mailto: link.
const FOOT_SEP = '<span class="sep" aria-hidden="true"> | </span>';
const SITE_FOOT = [
  '<footer class="sitefoot">',
  `<p>${[
    `<a class="home" href="${INDEX_PATH}" target="_self">${MARK_SVG}${SITE_NAME}</a>`,
    BLYG.description.replace(/\.$/, ""),
    `Orchestrated by <a href="${BLYG.author.url}">${BLYG.author.name}</a>`,
    "Reachable via matt@thisdomain",
  ].map((part) => `<span class="part">${part}</span>`).join(FOOT_SEP)}</p>`,
  "</footer>",
].join("\n");

// At the head of every page but the stream (which has its masthead): the mark,
// centred, back to the stream.
const NOTE_HEAD = `<header class="notehead"><a href="${INDEX_PATH}" target="_self" rel="home" aria-label="${SITE_NAME}: home">${MARK_SVG}</a></header>`;

/** Puts the mark at the head of the body, replacing any already there. */
function withNoteHead(html) {
  const out = removeBlock(html, '<header class="notehead">', "</header>");
  const open = out.match(/<body[^>]*>\n?/);
  if (!open) return out;
  const at = open.index + open[0].length;
  return `${out.slice(0, at)}${NOTE_HEAD}\n${out.slice(at)}`;
}

// Paths the surface owns, which no note may be published at.
const SURFACE_NAMES = ["blyg", "feed", "items"];

// Withdrawal is read off a page's absence, so a bad checkout or a slip of
// `git rm` would withdraw whatever it took with it — permanently, as far as
// the version numbers go. More than this many at once stops the build instead.
const MAX_WITHDRAWALS = 3;

const check = process.argv.includes("--check");
const stateMode = process.argv.includes("--state");
const massWithdrawal = process.argv.includes("--allow-mass-withdrawal");
const now = process.env.BLYG_NOW ? new Date(process.env.BLYG_NOW) : new Date();

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
  // An apostrophe may arrive escaped (markdown renderers write &#39;), and
  // must close up like a typed one rather than become a space.
  .replace(/&(?:#39|#x27|apos|rsquo|lsquo);/gi, "'")
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
    // The body as its publisher wrote it, before the title is promoted: this,
    // not anything the build does to it, is the blyg item's content.
    source: main.inner.trim(),
    pin: asksForPin(html),
    changeNote: changeNoteOf(html),
    // The model that wrote the page, when a machine did (§5.7, docs/blyg.md P20).
    generated: html.match(/<meta name="blyg:generated" content="([^"{}]+)"/)?.[1] ?? null,
    // The kind a page asks to be born as (§5.3, docs/blyg.md P21): only "thread"
    // means anything, and only when the note is first registered.
    kind: html.match(/<meta name="blyg:kind" content="(thread|fragment)"/)?.[1] ?? null,
    // Which write of the page this is, so a request in it is read only once.
    seen: createHash("sha256").update(html).digest("hex").slice(0, 16),
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
// mid-word by someone else's ellipsis. Search results rewrite or cut a
// description under 50 characters or over 165, and a title (with the site's
// name) over 65.
const DESCRIPTION_LENGTH = 160;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 165;
const TITLE_MAX = 65;

/** How long a piece of attribute text reads, entities counted as one character. */
const shownLength = (text) => text.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, "x").length;

/**
 * A page's <title>: "<title> | Kinocomputing" when that fits a search result,
 * the title alone when it doesn't — a cut-off title loses the words that matter.
 */
const pageTitle = (title) => {
  const full = `${title} | ${SITE_NAME}`;
  return shownLength(full) <= TITLE_MAX ? full : title;
};

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
  // The opening paragraph, and the next ones too while it's too short to be
  // a usable snippet (a one-line opener, a dateline).
  let text = "";
  let block = firstBlock(rest.trim());
  while (block) {
    // A byline ("By Concrete, one of the lab's AI voices") is a line wholly in
    // italics: it says who, not what, so it's no part of a description.
    if (/^<p>\s*<em>[\s\S]*<\/em>\s*<\/p>$/.test(block.block.trim()) && !/<\/em>[\s\S]*<em>/.test(block.block)) {
      block = firstBlock(block.rest.trim());
      continue;
    }
    text = `${text} ${stripTags(block.block)}`.trim();
    if (text.length >= DESCRIPTION_MIN) break;
    block = firstBlock(block.rest.trim());
  }
  return text ? asText(truncate(text, DESCRIPTION_LENGTH)) : "";
}

/**
 * Sets both description tags to one value. An authored description wins when
 * it is usable as a search snippet: 50 to 165 characters, and not just the
 * title again (which is what a publisher that copies the first line writes
 * for a titled note). Otherwise the derived one, from the opening
 * paragraphs, takes its place; an unusable authored one is still better than
 * nothing when nothing can be derived.
 */
function withDescription(html, derived, title = "") {
  const read = (pattern) => html.match(pattern)?.[1]?.trim() ?? "";
  const name = /<meta name="description" content="([^"]*)">/;
  const og = /<meta property="og:description" content="([^"]*)">/;

  const usable = (v) => v && shownLength(v) >= DESCRIPTION_MIN && shownLength(v) <= DESCRIPTION_MAX
    && v.toLowerCase() !== title.toLowerCase();
  const authored = read(name) || read(og);
  const value = usable(authored) ? authored : derived || authored;
  if (!value) return html;

  let out = html;
  for (const [pattern, tag] of [
    [name, `<meta name="description" content="${value}">`],
    [og, `<meta property="og:description" content="${value}">`],
  ]) {
    const found = out.match(pattern);
    if (found?.[1].trim() === value) continue;
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
    datetime_iso: note.time,
    datetime: displayTime(note.time),
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
    favicon,
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
    datetime_iso: note.time,
    datetime: displayTime(note.time),
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
/**
 * Links within the site open where you are. Every page has `<base
 * target="_blank">`, so links out open a new tab; a link to another page of
 * this site, relative or absolute (apex or www), that names no target of its
 * own gets `target="_self"`. Run on every page as it is written, so a note's
 * content, a lab note's absolute links and the stream all behave the same.
 */
const SAME_SITE = /^(?:\/(?!\/)|https?:\/\/(?:www\.)?kinocomputing\.com(?:[/?#]|$))/i;
function withSameSiteLinks(html) {
  return html.replace(/<a\b([^>]*)>/gi, (tag, attrs) => {
    if (/\starget\s*=/i.test(attrs)) return tag;
    const href = attrs.match(/\shref\s*=\s*"([^"]*)"/i)?.[1];
    return href != null && SAME_SITE.test(href) ? `<a${attrs} target="_self">` : tag;
  });
}

// AGENT READINESS. What search engines and AI assistants read without
// guessing: structured data on every note and the stream, a sitemap, an
// llms.txt, a security.txt. All derived from the notes at every build, so
// each new note is covered the moment it is published.

const LAB_REPO = "https://github.com/msmsim/kinocomputing-lab";
const IDS = {
  website: `${SITE_BASE}/#website`,
  project: `${SITE_BASE}/#project`,
  author: `${SITE_BASE}/#author`,
  lab: `${SITE_BASE}/#lab`,
};
const GRAPH = [
  { "@type": "WebSite", "@id": IDS.website, url: `${SITE_BASE}/`, name: SITE_NAME,
    description: BLYG.description, inLanguage: "en", publisher: { "@id": IDS.project } },
  { "@type": "ResearchProject", "@id": IDS.project, name: SITE_NAME, url: `${SITE_BASE}/`,
    description: BLYG.description, founder: { "@id": IDS.author },
    sameAs: [BLYG.generatorUrl, LAB_REPO] },
  { "@type": "Person", "@id": IDS.author, name: BLYG.author.name, url: BLYG.author.url },
  { "@type": "Organization", "@id": IDS.lab, name: `${SITE_NAME} lab`, url: `${SITE_BASE}/about`,
    description: "An automated research lab: an AI researcher works a nightly shift on alternative paradigms of computing and intelligence, steered by the project's founder.",
    parentOrganization: { "@id": IDS.project }, sameAs: [LAB_REPO] },
];

/** Attribute or element text back to plain text, for JSON and plain-text files. */
const plain = (text) => text
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&rsquo;/g, "’")
  .replace(/&lsquo;/g, "‘").replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/** One <script type="application/ld+json"> in the head, replacing any earlier one. */
function withStructuredData(html, graph) {
  const out = html.replace(/[ \t]*<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/g, "");
  const end = out.indexOf("</head>");
  if (end === -1) return out;
  // "<" escaped so no value can close the script element.
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `${out.slice(0, end)}    <script type="application/ld+json">${json}</script>\n${out.slice(end)}`;
}

/** A note as schema.org sees it: who wrote it (the PI, or the lab), when, which version. */
function noteGraph(note, entry, description) {
  const url = `${SITE_BASE}${note.path}`;
  const changelog = entry?.changelog ?? [];
  const page = {
    "@type": note.fileSlug === "about" ? "AboutPage" : "BlogPosting",
    "@id": url,
    url,
    mainEntityOfPage: url,
    headline: plain(note.title ? asText(note.title) : note.slug).slice(0, 110),
    ...(description ? { description: plain(description) } : {}),
    datePublished: changelog[0]?.at ?? note.iso,
    dateModified: changelog.at(-1)?.at ?? note.iso,
    ...(changelog.length ? { version: String(changelog.at(-1).version) } : {}),
    inLanguage: "en",
    isPartOf: { "@id": IDS.website },
    publisher: { "@id": IDS.project },
    author: { "@id": note.generated ? IDS.lab : IDS.author },
    ...(note.generated ? { creditText: `Written by an AI researcher (${note.generated}) in the ${SITE_NAME} lab` } : {}),
  };
  return [page, ...GRAPH];
}

/** sitemap.xml: the stream and every live note, each with when it last changed. */
function renderSitemap(notes) {
  const url = (loc, lastmod) => `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
  const lastOf = (note) => registry.items[note.fileSlug]?.changelog.at(-1)?.at ?? note.iso;
  const newest = notes.map(lastOf).sort().at(-1);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    url(`${SITE_BASE}/`, newest),
    ...[...notes].sort((a, b) => a.path.localeCompare(b.path)).map((note) => url(`${SITE_BASE}${note.path}`, lastOf(note))),
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * llms.txt (llmstxt.org): what the site is, in a paragraph, then links an AI
 * model can follow — the pages that explain it, the machine-readable
 * surface, the paradigm entries, and the latest notes.
 */
function renderLlmsTxt(notes) {
  const line = (note) => {
    const description = describe(note);
    const title = plain(note.title ? asText(note.title) : note.slug);
    return `- [${title}](${SITE_BASE}${note.path})${description ? `: ${plain(description)}` : ""}`;
  };
  const by = (fileSlug) => notes.find((note) => note.fileSlug === fileSlug);
  const newestFirst = [...notes].sort((a, b) => b.iso.localeCompare(a.iso));
  const paradigms = newestFirst.filter((note) => /^lab-\d{4}-\d{2}-\d{2}-paradigm-/.test(note.fileSlug) && !/-tracker$/.test(note.fileSlug))
    .sort((a, b) => a.path.localeCompare(b.path));
  const latest = newestFirst.filter((note) => !/-brief$/.test(note.fileSlug) && note.fileSlug !== "about").slice(0, 30);
  const start = ["about", "015-ochre-cranes", "lab-2026-11-21-paradigm-tracker"].map(by).filter(Boolean);
  return [
    `# ${SITE_NAME}`,
    "",
    `> ${BLYG.description} A one-person research project by ${BLYG.author.name}, with an automated research lab: an AI researcher works a nightly shift, running small open experiments, checking the literature, and keeping a tracker of alternative computing paradigms (thermodynamic and probabilistic, neuromorphic, analog in-memory, photonic, reversible, physical reservoirs, living substrates and more), each revisited every two weeks.`,
    "",
    "Every note is also published as JSON through the site's blyg (a protocol for versioned, quotable notes), with its full version history. The lab's notes link to their evidence: code, data and results in a public repository. Claims state how sure the lab is in plain words.",
    "",
    "## Start here",
    "",
    ...start.map(line),
    "",
    "## Machine-readable",
    "",
    `- [Blyg manifest](${SITE_BASE}/blyg.json): every note, its versions and its JSON`,
    `- [Feed](${SITE_BASE}/feed.xml): RSS of the latest notes`,
    `- [Sitemap](${SITE_BASE}/sitemap.xml): every page`,
    `- [The lab's repository](${LAB_REPO}): its charter, its researcher's instructions, every experiment with code and data`,
    "",
    ...(paradigms.length ? ["## The paradigm tracker's entries", "", ...paradigms.map(line), ""] : []),
    "## Latest notes",
    "",
    ...latest.map(line),
    "",
  ].join("\n");
}

/**
 * robots.txt: the site's own policy, kept here rather than in Cloudflare's
 * managed file. The site exists to spread its ideas and sells nothing, so
 * the named crawlers of the assistants people ask — for search, live
 * answers and training alike — are welcome. Refused are the scrapers that
 * resell, monitor or harvest and bring no readers. Everyone else may read.
 */
const CRAWLERS_REFUSED = [
  "Bytespider", "Diffbot", "omgili", "PetalBot",
  "AwarioSmartBot", "AwarioRssBot", "QualifiedBot", "ICC-Crawler", "atlassian-bot",
  "FishBot", "BorderxBot", "NavuBot", "SemrushBot-SWA", "WARDBot", "magpie-crawler",
  "CitibotSiteCrawler", "Cotoyogi",
];
function renderRobots() {
  return [
    "# Kinocomputing. Search, AI answers and training are all welcome:",
    "# the point of the site is to be read. Scrapers that resell or monitor",
    "# are not. Policy: README.md, \"Agent readiness\".",
    "",
    "User-agent: *",
    "Content-Signal: search=yes,ai-input=yes,ai-train=yes",
    "Allow: /",
    "",
    ...CRAWLERS_REFUSED.map((bot) => `User-agent: ${bot}`),
    "Disallow: /",
    "",
    `Sitemap: ${SITE_BASE}/sitemap.xml`,
    "",
  ].join("\n");
}

/** security.txt (RFC 9116): where to report a problem; expiring 11 months from the month it was built. */
function renderSecurityTxt() {
  const expires = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 11, 1));
  return [
    `Contact: ${SITE_BASE}/about`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "Preferred-Languages: en",
    `Canonical: ${SITE_BASE}/.well-known/security.txt`,
    "",
  ].join("\n");
}

/** A page's last step before it is written. */
function finishPage(html) {
  return withAnalytics(withSameSiteLinks(html));
}

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
 * Puts the site footer last in the body, replacing any already there. It goes
 * in ahead of the counter script, which withAnalytics then puts after it.
 */
function withSiteFoot(html) {
  const out = removeBlock(html, '<footer class="sitefoot">', "</footer>");
  const end = out.lastIndexOf("</body>");
  if (end === -1) return out;
  return `${out.slice(0, end)}${SITE_FOOT}\n${out.slice(end)}`;
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
    tag: `<title>${pageTitle(title)}</title>` },
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
  // Three icons: .ico at the conventional address for anything that asks for
  // it there (Safari, feed readers, link previews), the SVG for browsers that
  // take one, and a square PNG for phones' home screens.
  { find: /<link rel="icon" href="\/favicon\.ico"[^>]*>/,
    tag: '<link rel="icon" href="/favicon.ico" sizes="32x32">' },
  { find: /<link rel="icon" type="image\/svg\+xml"[^>]*>/,
    tag: `<link rel="icon" type="image/svg+xml" href="${favicon}">` },
  { find: /<link rel="apple-touch-icon"[^>]*>/,
    tag: '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' },
  // The phone's browser bars take the page colour (note.css) rather than white.
  { find: /<meta name="theme-color"[^>]*>/,
    tag: '<meta name="theme-color" content="#cbdff7">' },
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
  else if (description && (shownLength(description) < DESCRIPTION_MIN || shownLength(description) > DESCRIPTION_MAX)) {
    say(`meta description is ${shownLength(description)} characters; search results rewrite one outside ${DESCRIPTION_MIN}–${DESCRIPTION_MAX}`);
  }
  const title = value(/<title>([^<]*)<\/title>/);
  if (title && shownLength(title) > TITLE_MAX) say(`title is ${shownLength(title)} characters even without the site's name; search results cut one over ${TITLE_MAX}`);
  if (!/<script type="application\/ld\+json">/.test(html)) say("no structured data");

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

/** Every file under dir, as relative /-separated path → bytes. Empty if dir is absent. */
async function readTree(dir) {
  const out = new Map();
  const walk = async (rel) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else out.set(path, await readFile(join(dir, path)));
    }
  };
  await walk("");
  return out;
}

const exists = (path) => access(path).then(() => true, () => false);

const files = (await readdir(SOURCE_DIR))
  .filter((name) => name.endsWith(".html"))
  .filter((name) => name !== "index.html" && !name.startsWith("_"));

const registryText = await readFile(REGISTRY, "utf8").catch(() => null);
const registry = { items: registryText ? JSON.parse(registryText).items ?? {} : {} };

const notes = [];
// Anything in the source folder that isn't a note still owns its name, so a
// title can't be slugified onto the path of a file the scan left alone.
const reserved = new Set(["index", "404", ...ASSETS, ...SURFACE_NAMES]);
// Every name with a file at it, note or not: what tells a withdrawn note (no
// file) from one that has merely stopped parsing.
const present = new Set();

for (const file of files) {
  const fileSlug = file.replace(/\.html$/, "");
  present.add(fileSlug);
  const html = await readFile(join(SOURCE_DIR, file), "utf8");
  const note = parseNote(fileSlug, html);
  if (!note) {
    console.warn(`skipped ${file}: no published_time or no <main>`);
    reserved.add(fileSlug);
    continue;
  }
  notes.push(note);
}

// A withdrawn note's address is its tombstone's, and a pinned version's frozen
// page is that version's, for good: no title may take either.
for (const [fileSlug, entry] of Object.entries(registry.items)) {
  if (!entry.page) continue;
  if (entry.withdrawn && !present.has(fileSlug)) reserved.add(entry.page);
  for (const event of entry.changelog) {
    if (event.pinned) reserved.add(pinnedPath(entry.page, event.version));
  }
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

// The notes as the blyg sees them: keyed by source file, which never changes,
// with the body as written and the page it is published at.
const blygNotes = notes.map((note) => ({
  slug: note.fileSlug,
  iso: note.iso,
  content: note.source,
  pin: note.pin,
  changeNote: note.changeNote,
  seen: note.seen,
  page: note.slug,
  generated: note.generated,
  kind: note.kind,
}));

if (stateMode) {
  // A Subset share of a blyg item is a stub of it (§10.6). Whether a note is
  // one is decided when it is first registered and kept in the registry, so
  // only a note the registry hasn't seen is resolved — the one network step in
  // the build, and never repeated. A target that doesn't resolve leaves a fragment.
  for (const note of blygNotes) {
    if (registry.items[note.slug]) continue;
    const target = stubTarget(note.content);
    if (!target) continue;
    try {
      note.stub = await resolveStub(target);
    } catch (error) {
      console.log(`blyg: ${note.slug} is not a stub: ${error.message}`);
    }
  }

  const { registry: next, events } = updateRegistry(registry, blygNotes, { now, present, site: BLYG });
  const registered = events.filter((event) => event.type === "new").length;
  if (registered) console.log(`blyg: registered ${registered} note(s)`);
  for (const event of events) {
    if (event.type === "version") console.log(`blyg: ${event.slug} is now v${event.version}`);
    if (event.type === "stub") console.log(`blyg: ${event.slug} is a stub of ${event.origin} ${event.id}`);
    if (event.type === "pinned") console.log(`blyg: pinned ${event.slug} v${event.version}`);
    if (event.type === "unconverted") console.warn(`blyg: left out ${event.slug}: ${event.reason}`);
    if (event.type === "withdrawn") console.log(`blyg: withdrew ${event.slug} as v${event.version}`);
    if (event.type === "kind-kept") console.warn(`blyg: ${event.slug} stays a ${event.kind}; an item's kind never changes`);
    if (event.type === "missing") console.warn(`blyg: ${event.slug} is registered but its page is not a note`);
  }
  const withdrawals = events.filter((event) => event.type === "withdrawn").length;
  if (withdrawals > MAX_WITHDRAWALS && !massWithdrawal) {
    console.error(`blyg: ${withdrawals} registered notes have no page. Withdrawing is permanent, `
      + "so nothing was written. If they were all meant, rerun with --allow-mass-withdrawal.");
    process.exit(1);
  }

  const writes = [];
  const serialized = serializeRegistry(next);
  if (serialized !== registryText) writes.push([REGISTRY, serialized]);

  // A document for a note that won't convert isn't produced, which leaves the
  // last good one in blyg/ — nothing here is ever deleted (§4: 200 forever).
  for (const [file, content] of buildSurfaces(next, blygNotes, BLYG)) {
    const path = join(STATE_DIR, file);
    const current = await readFile(path, "utf8").catch(() => null);
    if (content !== current) writes.push([path, content]);
  }
  // A pin is a promise about exact bytes, so its document is written once:
  // one that already exists is never touched again.
  for (const pin of buildPins(next, blygNotes, BLYG)) {
    const path = join(STATE_DIR, pin.file);
    if (!await exists(path)) writes.push([path, pin.content]);
  }

  if (writes.length === 0) {
    console.log(`blyg: ${notes.length} notes, already up to date`);
    process.exit(0);
  }
  if (check) {
    console.error(`blyg: ${writes.length} file(s) would change:`);
    for (const [path] of writes) console.error(`  ${path}`);
    process.exit(1);
  }
  for (const [path, content] of writes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  console.log(`blyg: ${notes.length} notes, wrote ${writes.length} file(s) to ${STATE_DIR}/`);
  process.exit(0);
}

// A thread shows its quotes as the registry baked them (P22), each with a
// line back to what it quotes, at the quoted version when that version is
// pinned. A quote the registry hasn't resolved — the page changed since the
// Action last ran, or it quotes something that can't be quoted — shows as a
// link to the note it names, and its selection if it has one.
const quotedFrom = (slug, version) => {
  const target = registry.items[slug];
  if (!target?.page) return "";
  const pinned = target.changelog.some((e) => e.version === version && e.pinned);
  const href = `${INDEX_PATH}${pinned ? pinnedPath(target.page, version) : target.page}`;
  return `\n<p class="quoted-from"><a href="${href}">${pinned ? `v${version}` : "quoted"}</a></p>`;
};
for (const note of notes) {
  if (!quotesIn(note.content).length) continue;
  const entry = registry.items[note.fileSlug];
  const baked = entry?.quotes ? withQuotes(note.content, entry.quotes,
    (q) => bakeQuote(q).replace(/\n<\/blockquote>$/, `${quotedFrom(q.slug, q.version)}\n</blockquote>`)) : null;
  note.content = baked ?? note.content.replace(/<blockquote\b[^>]*\sclass="kino-quote"[^>]*>([\s\S]*?)<\/blockquote>/g, (block, inner) => {
    const slug = block.match(/\sdata-note="([^"]+)"/)?.[1] ?? "";
    const page = registry.items[slug]?.page ?? slug;
    return `<blockquote class="quote-pending">${inner}<p class="quoted-from"><a href="${INDEX_PATH}${page}">${page}</a></p></blockquote>`;
  });
}

// Newest first, as the stream reads, by when each note last changed: an edited
// note returns to the top. Ties break on slug so the order is total and a
// rerun can't shuffle two notes published in the same second.
for (const note of notes) note.time = latestTime(registry, { slug: note.fileSlug, iso: note.iso });
notes.sort((a, b) => new Date(b.time) - new Date(a.time) || b.slug.localeCompare(a.slug));

// Beside the notes, which is where motes looks for them too.
const streamTemplate = await readFile(join(SOURCE_DIR, "_stream.html"), "utf8");
const noteTemplate = await readFile(join(SOURCE_DIR, "_note.html"), "utf8");

// The stylesheet is fingerprinted with its own contents. Every page is rebuilt
// on each deploy anyway, so the cost is nothing, and it means an edit to
// note.css can't be masked by a browser or an edge cache still holding the old
// one — which is otherwise indistinguishable from the edit not working.
const assets = new Map();
for (const name of ASSETS) assets.set(name, await readFile(name));

const stylesheet = `/note.css?v=${createHash("sha256")
  .update(assets.get("note.css")).digest("hex").slice(0, 8)}`;

// The icon, □◇ ("always eventually", liveness), fingerprinted for the same
// reason: browsers hold on to a favicon longer than to anything else.
const favicon = `/favicon.svg?v=${createHash("sha256")
  .update(assets.get("favicon.svg")).digest("hex").slice(0, 8)}`;

// The card, fingerprinted for the same reason and one more: the social
// scrapers cache by URL for days, so a redrawn card at an unchanged URL keeps
// being shared as the old one. og:image must be absolute — the scrapers fetch
// it without a page to resolve against. A missing file is a warning rather than
// a failure; a deploy with no share card is better than no deploy.
const card = await readFile(OG_IMAGE).catch(() => null);
if (!card) console.warn(`${OG_IMAGE}: not found, publishing without a share card`);
if (card) assets.set(OG_IMAGE, card);
const image = card && {
  url: `${SITE_BASE}/${OG_IMAGE}?v=${createHash("sha256")
    .update(card).digest("hex").slice(0, 8)}`,
  ...(imageSize(card) ?? {}),
};

// The deploy, built in memory and compared against what is on disk at the end.
// Nothing under the source folder is written to, so a local build leaves the
// notes exactly as their publisher wrote them.
const site = new Map(assets);

// The blyg surface, exactly as the Action committed it. The _-prefixed files
// beside it are state, not surface.
for (const [path, content] of await readTree(STATE_DIR)) {
  if (!path.split("/").some((part) => part.startsWith("_"))) site.set(path, content);
}

site.set("index.html", finishPage(withSiteFoot(withStructuredData(renderStream(streamTemplate, notes), GRAPH))));

notes.forEach((note, i) => {
  const { html } = note;

  let updated = normaliseHead(html, {
    // A titled note is named by its title; an untitled one falls back to the
    // slug, which is the only other name it has.
    title: note.title ? asText(note.title) : note.slug,
    url: `${SITE_BASE}${note.path}`,
    type: "article",
  });
  updated = withDescription(updated, describe(note), note.title ? asText(note.title) : "");
  updated = withStructuredData(updated, noteGraph(note, registry.items[note.fileSlug],
    updated.match(/<meta name="description" content="([^"]*)">/)?.[1] ?? ""));
  updated = withMain(updated, note.content);
  updated = removeBlock(updated, '<nav class="back">', "</nav>");
  updated = removeBlock(updated, '<footer class="masthead">', "</footer>");
  updated = withNotefoot(updated, renderNotefoot(
    noteTemplate, note, notes[i + 1] ?? null, notes[i - 1] ?? null
  ));
  // A pin or change-note request is for the Action; once it has been read it
  // means nothing to anyone, so it never ships.
  updated = withoutChangeNote(withoutPinRequest(updated));
  const entry = registry.items[note.fileSlug];
  if (entry) {
    updated = withVersions(withHeadLinks(updated, INDEX_PATH, entry.id), renderVersions(entry, note.path));
  }
  updated = finishPage(withSiteFoot(withNoteHead(updated)));

  // Audited after the rewrites, so it reports what actually ships rather than
  // what the publisher happened to hand over.
  auditHead(updated, note.slug);

  site.set(`${note.slug}.html`, updated);
});

/** The note template with every optional section and the publication time taken out. */
const bareTemplate = (template) => template
  .replace(/<!-- if:(\w+) -->[\s\S]*?<!-- \/if:\1 -->\n?/g, "")
  .replace(/^[ \t]*<meta property="article:published_time"[^>]*>\n/m, "");

/**
 * The frozen page for one pinned version (§8.4): the pin document's content in
 * the site's note chrome, its leading bold line promoted to the title exactly
 * as on the live page — the words are the pin's, verbatim; the heading is
 * presentation, as it is everywhere else on the site. It is canonical to the live note, links
 * its own JSON twin, and carries no published_time, so nothing reads it as a
 * note. Its prev/next are the live note's, so a reader can carry on through
 * the stream from an old version as from the live one.
 */
function renderPinned(entry, page, pin, older, newer) {
  const livePath = `${INDEX_PATH}${page}`;
  const path = pinnedPath(livePath, pin.version);
  const { title, content } = readTitle(pin.content_html);
  let html = fill(bareTemplate(noteTemplate), {
    slug: page, description: "", url: `${SITE_BASE}${livePath}`, path, index_path: INDEX_PATH,
    content, datetime_iso: pin.at, datetime: displayTime(pin.at),
  });
  html = normaliseHead(html, {
    title: `${title ? asText(title) : page} (v${pin.version})`, url: `${SITE_BASE}${livePath}`, type: "article",
  });
  html = withDescription(html, describe({ title, content }));
  html = withNotefoot(html, renderNotefoot(noteTemplate, { path, time: pin.at }, older, newer));
  html = withPinnedVersions(html, renderPinnedVersions(entry, livePath, pin.version));
  html = withHeadLinks(html, INDEX_PATH, entry.id).replace(
    `${INDEX_PATH}items/${entry.id}.json"`, `${INDEX_PATH}items/${entry.id}/v${pin.version}.json"`
  );
  return finishPage(withSiteFoot(withNoteHead(html)));
}

/**
 * What stands at a withdrawn note's address (§5.8, §9): a page saying it was
 * withdrawn, when, and which versions stay pinned. Nothing of what it said.
 */
function renderTombstone(entry, page) {
  const livePath = `${INDEX_PATH}${page}`;
  const at = entry.changelog.at(-1).at;
  let html = fill(bareTemplate(noteTemplate), {
    slug: page, description: "This note has been withdrawn.", url: `${SITE_BASE}${livePath}`,
    path: livePath, index_path: INDEX_PATH,
    content: '<p class="withdrawn">This note has been withdrawn.</p>',
    datetime_iso: at, datetime: displayTime(at),
  });
  html = normaliseHead(html, { title: "Withdrawn", url: `${SITE_BASE}${livePath}`, type: "article" });
  html = withNotefoot(html, renderNotefoot(noteTemplate, { path: livePath, time: at }, null, null));
  html = withVersions(withHeadLinks(html, INDEX_PATH, entry.id), renderWithdrawn(entry, livePath));
  return finishPage(withSiteFoot(withNoteHead(html)));
}

/**
 * What Cloudflare serves, with a 404, for any address the site doesn't have.
 * Without it Pages falls back to the stream, so every mistyped URL — and every
 * convention-path request like /favicon.ico used to be — came back as the home
 * page with a 200. No canonical, not indexed, and the way home is the footer's.
 */
function renderNotFound() {
  let html = fill(bareTemplate(noteTemplate), {
    slug: "Not found", description: "There is nothing at this address.", url: "", path: INDEX_PATH,
    index_path: INDEX_PATH, content: "<p>There is nothing at this address.</p>",
    datetime_iso: "", datetime: "",
  });
  html = normaliseHead(html, { title: "Not found", url: SITE_BASE, type: "website" })
    .replace(/^[ \t]*<link rel="canonical"[^>]*>\n/m, "")
    .replace(/^[ \t]*<meta property="og:url"[^>]*>\n/m, "")
    .replace("</head>", '    <meta name="robots" content="noindex">\n</head>');
  html = withNotefoot(html, renderNotefoot(noteTemplate, null, null, null));
  return finishPage(withSiteFoot(withNoteHead(html)));
}

site.set("404.html", renderNotFound());

const position = new Map(notes.map((note, i) => [note.fileSlug, i]));
for (const [fileSlug, entry] of Object.entries(registry.items)) {
  const page = entry.page ?? fileSlug;
  const i = position.get(fileSlug);
  for (const event of entry.changelog) {
    if (!event.pinned) continue;
    const source = site.get(`items/${entry.id}/v${event.version}.json`);
    if (!source) {
      console.warn(`blyg: ${fileSlug} v${event.version} is pinned but has no pin document`);
      continue;
    }
    const name = `${pinnedPath(page, event.version)}.html`;
    if (site.has(name)) {
      console.warn(`blyg: ${name} is taken, so ${fileSlug} v${event.version} has no frozen page`);
      continue;
    }
    site.set(name, renderPinned(entry, page, JSON.parse(source),
      i === undefined ? null : notes[i + 1] ?? null,
      i === undefined ? null : notes[i - 1] ?? null));
  }
  if (entry.withdrawn && !present.has(fileSlug)) {
    if (site.has(`${page}.html`)) console.warn(`blyg: ${page} is taken, so ${fileSlug} has no tombstone`);
    else site.set(`${page}.html`, renderTombstone(entry, page));
  }
}

/**
 * Keeps every URL a note has ever been reachable at pointing at the note.
 *
 * A note is published under its title, but its file is named by whatever
 * motes generated, so `/042-teal-otters` has to reach a retitled note. motes
 * writes internal links as `/<source folder>/<file name>`, because it
 * addresses a repo path and a URL path with one setting — those arrive in the
 * note body, which the build passes through untouched, so they are met with a
 * redirect rather than a rewrite. And a page the blyg has published an item at
 * is a promise (§5.8): when a retitle moves the note, or a withdrawal leaves
 * only its tombstone, the old address follows it, frozen versions included.
 *
 * A `_redirects` at the repo root is folded in for anything the build can't
 * know about — a URL from a previous site, say. A path that something is
 * actually served at is never redirected.
 */
async function renderRedirects() {
  const seed = await readFile(REDIRECTS, "utf8").catch(() => "");
  const lines = new Set(seed.split("\n").map((line) => line.trim()).filter(Boolean));
  const served = (path) => site.has(`${path.slice(INDEX_PATH.length)}.html`);
  const add = (from, to) => {
    if (from !== to && !served(from)) lines.add(`${from} ${to} 301`);
  };

  for (const note of notes) {
    add(`${INDEX_PATH}${SOURCE_DIR}/${note.fileSlug}`, note.path);
    add(`${INDEX_PATH}${note.fileSlug}`, note.path);
  }
  for (const [fileSlug, entry] of Object.entries(registry.items)) {
    const page = entry.page ?? fileSlug;
    const live = notes.find((note) => note.fileSlug === fileSlug);
    const target = live ? live.path : `${INDEX_PATH}${page}`;
    if (!live && !served(target)) continue;
    add(`${INDEX_PATH}${SOURCE_DIR}/${fileSlug}`, target);
    add(`${INDEX_PATH}${fileSlug}`, target);
    for (const old of [...(entry.moved_from ?? []), page]) {
      add(`${INDEX_PATH}${old}`, target);
      for (const event of entry.changelog) {
        if (event.pinned && old !== page) {
          add(pinnedPath(`${INDEX_PATH}${old}`, event.version), pinnedPath(`${INDEX_PATH}${page}`, event.version));
        }
      }
    }
  }
  return `${[...lines].sort().join("\n")}\n`;
}

site.set(REDIRECTS, await renderRedirects());
site.set("sitemap.xml", renderSitemap(notes));
site.set("llms.txt", renderLlmsTxt(notes));
site.set(".well-known/security.txt", renderSecurityTxt());
site.set("robots.txt", renderRobots());

// What the deploy folder holds now, so a page dropped from the site is noticed
// as a change and doesn't linger from an earlier build.
const existing = await readTree(OUT_DIR);

// A file absent from the deploy reads as undefined here, not as empty content.
const same = (a, b) =>
  a != null && b != null && Buffer.from(a).equals(Buffer.from(b));

const changed = [...site.keys()].filter((n) => !same(site.get(n), existing.get(n)));
const stale = [...existing.keys()].filter((n) => !site.has(n));

if (changed.length === 0 && stale.length === 0) {
  console.log(`${notes.length} notes, already up to date`);
  process.exit(0);
}

if (check) {
  console.error(`${changed.length + stale.length} file(s) would change:`);
  for (const name of changed) console.error(`  ${join(OUT_DIR, name)}`);
  for (const name of stale) console.error(`  ${join(OUT_DIR, name)} (removed)`);
  process.exit(1);
}

// Rebuilt from empty rather than patched, so the folder can only ever hold what
// this run produced — the same guarantee the fresh checkout gives in CI.
await rm(OUT_DIR, { recursive: true, force: true });
for (const [name, content] of site) {
  await mkdir(dirname(join(OUT_DIR, name)), { recursive: true });
  await writeFile(join(OUT_DIR, name), content);
}

console.log(`${notes.length} notes, wrote ${site.size} file(s) to ${OUT_DIR}/`);
