// Blygger (https://blygger.org/spec/0.3/) support for the notes build.
//
// A blyg item's ground truth is its markdown (`content_md`), and its version
// history is driven by the hash of that markdown. Note pages only carry HTML,
// so the markdown is reconstructed here from the <main> body.
//
// FROZEN: the output of htmlToMarkdown() is hashed into every item's
// content_hash. Any change to what it emits for existing notes bumps the
// version of every affected note at once. Treat a change as a deliberate
// mass-version event, never as a tidy-up.

import { createHash, randomBytes } from "node:crypto";

const BLYG_VERSION = "0.3";

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", middot: "·", bull: "•", times: "×", minus: "−", deg: "°",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", copy: "©", reg: "®", trade: "™",
  pound: "£", euro: "€", sect: "§", para: "¶", prime: "′", Prime: "″",
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(ENTITIES, name)) throw new Error(`unknown entity ${whole}`);
    return ENTITIES[name];
  });
}

/** Backslash-escapes the characters that would otherwise start inline markdown. */
const escapeInline = (text) => text.replace(/[\\*_[\]`<]/g, "\\$&");

/** Escapes a line that would otherwise open a heading, quote, list or rule. */
const escapeLineStart = (line) => line
  .replace(/^(#{1,6}(?:\s|$)|>|[-+](?:\s|$))/, "\\$1")
  .replace(/^(\d+)([.)])(\s|$)/, "$1\\$2$3");

function tokenize(html) {
  return html.split(/(<[^>]+>)/).filter((part) => part !== "").map((part) => {
    if (part[0] !== "<") return { type: "text", text: part };
    const tag = part.match(/^<(\/?)([a-zA-Z0-9]+)((?:\s[^>]*)?)\/?>$/);
    if (!tag) throw new Error(`unparseable tag ${part}`);
    return { type: tag[1] ? "close" : "open", name: tag[2].toLowerCase(), attrs: tag[3] };
  });
}

const INLINE = { em: "*", i: "*", strong: "**", b: "**", del: "~~", s: "~~", strike: "~~" };
const HEADING = /^h([1-6])$/;
const BLOCKS = new Set([
  "p", "ul", "ol", "blockquote", "pre", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
]);

/** A backtick run longer than any in `text`, at least `min` long. */
const fence = (text, min) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(min, longest + 1));
};

/**
 * The note body's HTML as markdown. Covers what a markdown renderer emits —
 * paragraphs, headings, lists (nested too), blockquotes, code blocks, rules,
 * links, images, emphasis, strikethrough, inline code, line breaks — and
 * throws on anything else, so an unfamiliar page is reported rather than
 * hashed into a version from a wrong reconstruction.
 *
 * A quote of another note (`<blockquote class="kino-quote" data-note="…">`,
 * P22) becomes a §10.1 directive, `![[id]]`, followed by its selection as a
 * blockquote when it quotes part of the note. `quote` maps the quoted note's
 * file slug to its item id, and throws when it can't be quoted; without it a
 * quote can't be converted. No note written before quotes existed has one, so
 * nothing frozen moves.
 */
export function htmlToMarkdown(html, { quote = null } = {}) {
  const tokens = tokenize(html);
  let at = 0;

  const expectClose = (name) => {
    const token = tokens[at];
    if (!token || token.type !== "close" || token.name !== name) {
      throw new Error(`expected </${name}>`);
    }
    at += 1;
  };

  // The text inside a code element up to its close tag, entities decoded and
  // any markup within it (a highlighter's spans, a <code> inside a <pre>) dropped.
  const verbatim = (until) => {
    let out = "";
    for (;;) {
      const token = tokens[at];
      if (!token) throw new Error(`unclosed <${until}>`);
      if (token.type === "close" && token.name === until) return out;
      at += 1;
      if (token.type === "text") out += decodeEntities(token.text);
    }
  };

  // Inline content up to (not including) the close tag of `until`, or, inside
  // a list item, the block that follows its text.
  const inline = (until, stopAtBlock = false) => {
    let out = "";
    for (;;) {
      const token = tokens[at];
      if (!token) throw new Error(`unclosed <${until}>`);
      if (token.type === "close") {
        if (token.name !== until) throw new Error(`unexpected </${token.name}> in <${until}>`);
        return out;
      }
      if (stopAtBlock && token.type === "open" && BLOCKS.has(token.name)) return out;
      at += 1;
      if (token.type === "text") {
        out += escapeInline(decodeEntities(token.text));
      } else if (Object.hasOwn(INLINE, token.name)) {
        const mark = INLINE[token.name];
        out += mark + inline(token.name) + mark;
        expectClose(token.name);
      } else if (token.name === "a") {
        const href = token.attrs.match(/\shref="([^"]*)"/);
        if (!href) throw new Error("<a> without href");
        const url = decodeEntities(href[1]);
        if (/[<>\n]/.test(url)) throw new Error(`unsupported link target ${url}`);
        const text = inline("a");
        expectClose("a");
        // Angle brackets keep a target with brackets or spaces in one piece.
        out += /[()\s]/.test(url) ? `[${text}](<${url}>)` : `[${text}](${url})`;
      } else if (token.name === "code") {
        const code = verbatim("code").replace(/\s+/g, " ");
        expectClose("code");
        const ticks = fence(code, 1);
        // Padded where a backtick at either edge would join the delimiter.
        const pad = /^`|`$/.test(code) ? " " : "";
        out += `${ticks}${pad}${code}${pad}${ticks}`;
      } else if (token.name === "br") {
        out += "\\\n";
      } else if (token.name === "img") {
        const src = token.attrs.match(/\ssrc="([^"]*)"/);
        if (!src) throw new Error("<img> without src");
        const url = decodeEntities(src[1]);
        if (/[<>\n]/.test(url)) throw new Error(`unsupported image source ${url}`);
        const alt = escapeInline(decodeEntities(token.attrs.match(/\salt="([^"]*)"/)?.[1] ?? ""));
        out += /[()\s]/.test(url) ? `![${alt}](<${url}>)` : `![${alt}](${url})`;
      } else {
        throw new Error(`unsupported inline element <${token.name}>`);
      }
    }
  };

  // Line edges carry no meaning in HTML but do in markdown (indented code,
  // hard breaks), so each line is trimmed before its start is escaped.
  const lines = (text) => text.trim().split("\n")
    .map((line) => escapeLineStart(line.trim()));

  const skipSpace = () => {
    while (tokens[at]?.type === "text" && tokens[at].text.trim() === "") at += 1;
  };

  // Block content up to the close tag of `until`, or the end at top level.
  const blocks = (until) => {
    const out = [];
    for (;;) {
      skipSpace();
      const token = tokens[at];
      if (!token) {
        if (until) throw new Error(`unclosed <${until}>`);
        return out;
      }
      if (token.type === "close") {
        if (token.name !== until) throw new Error(`unexpected </${token.name}>`);
        return out;
      }
      if (token.type === "text") throw new Error(`text outside a block: ${token.text.trim().slice(0, 40)}`);
      if (!BLOCKS.has(token.name)) throw new Error(`unsupported block element <${token.name}>`);
      at += 1;

      if (token.name === "p") {
        out.push(lines(inline("p")).join("\n"));
        expectClose("p");
      } else if (token.name === "blockquote" && QUOTE_CLASS.test(token.attrs)) {
        const slug = token.attrs.match(/\sdata-note="([^"]+)"/)?.[1];
        if (!slug) throw new Error("a quote without data-note");
        // The selection is plain text, one <p> per line; nothing else.
        const selection = [];
        for (;;) {
          skipSpace();
          const next = tokens[at];
          if (next?.type === "close" && next.name === "blockquote") break;
          if (next?.type !== "open" || next.name !== "p") throw new Error(`a quote of ${slug} holds something other than plain paragraphs`);
          at += 1;
          const text = tokens[at]?.type === "text" ? decodeEntities(tokens[at++].text) : "";
          expectClose("p");
          const line = text.replace(/\s+/g, " ").trim();
          if (!line) throw new Error(`a quote of ${slug} has an empty line`);
          selection.push(line);
        }
        expectClose("blockquote");
        if (!quote) throw new Error(`quotes ${slug}, and quotes need resolving`);
        const id = quote(decodeEntities(slug));
        out.push([`![[${id}]]`, ...selection.map((line) => `> ${escapeLineStart(escapeInline(line))}`)].join("\n"));
      } else if (token.name === "blockquote") {
        const quoted = blocks("blockquote").join("\n\n");
        expectClose("blockquote");
        out.push(quoted.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"));
      } else if (token.name === "hr") {
        out.push("---");
      } else if (token.name === "pre") {
        const language = /\bclass="[^"]*\blanguage-([\w+#.-]+)/;
        const named = token.attrs.match(language) ?? tokens[at]?.attrs?.match(language);
        const code = verbatim("pre").replace(/\n$/, "");
        expectClose("pre");
        const ticks = fence(code, 3);
        out.push(`${ticks}${named ? named[1] : ""}\n${code}\n${ticks}`);
      } else if (HEADING.test(token.name)) {
        const marks = "#".repeat(Number(token.name[1]));
        out.push(`${marks} ${lines(inline(token.name)).join(" ")}`);
        expectClose(token.name);
      } else {
        const items = [];
        for (;;) {
          skipSpace();
          const next = tokens[at];
          if (next?.type === "close") break;
          if (next?.type !== "open" || next.name !== "li") throw new Error("expected <li>");
          at += 1;
          const marker = token.name === "ol" ? `${items.length + 1}. ` : "- ";
          // An item is its text, then any blocks nested in it. A nested list
          // sits tight under the text; anything else takes a blank line.
          const text = inline("li", true);
          const nested = blocks("li");
          expectClose("li");
          const parts = text.trim() === "" && nested.length ? [] : [lines(text).join("\n")];
          for (const block of nested) {
            const tight = parts.length === 1 && /^(?:- |\d+\. )/.test(block);
            parts.push(parts.length === 0 ? block : `${tight ? "\n" : "\n\n"}${block}`);
          }
          items.push(marker + parts.join("").split("\n").join(`\n${" ".repeat(marker.length)}`));
        }
        expectClose(token.name);
        out.push(items.join("\n"));
      }
    }
  };

  return blocks(null).join("\n\n");
}

const QUOTE_CLASS = /\sclass="kino-quote"/;
const QUOTE_BLOCK = /<blockquote\b[^>]*\sclass="kino-quote"[^>]*>[\s\S]*?<\/blockquote>/g;

/**
 * The quotes in a note body, in order: the quoted note's file slug and the
 * selection's lines (none for a whole quote). Only well-formed quotes are
 * listed; htmlToMarkdown is what refuses a malformed one.
 */
export function quotesIn(html) {
  return [...html.matchAll(QUOTE_BLOCK)].map(([block]) => ({
    slug: decodeEntities(block.match(/\sdata-note="([^"]+)"/)?.[1] ?? ""),
    lines: [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => decodeEntities(m[1]).replace(/\s+/g, " ").trim()),
  }));
}

/**
 * §2's text content: tags stripped, whitespace collapsed, block boundaries
 * kept as line breaks. What a partial quote's selection must be found in.
 */
export function textContent(html) {
  const decoded = html
    .replace(/<\/(?:p|h[1-6]|li|blockquote|pre|div)>|<br\s*\/?>|<hr\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole) => {
      try {
        return decodeEntities(whole);
      } catch {
        return whole;
      }
    });
  return decoded.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A resolved quote as it is baked into content_html (§10.2): the target's
 * snapshot whole, or the selection's lines, escaped, one paragraph each.
 */
export function bakeQuote(quote) {
  const attrs = `data-blyg-id="${quote.id}" data-blyg-version="${quote.version}"`;
  return quote.exact === undefined
    ? `<blockquote class="blyg-transclusion" ${attrs}>\n${quote.html}\n</blockquote>`
    : `<blockquote class="blyg-transclusion blyg-partial" ${attrs}>\n${quote.exact.split("\n").map((line) => `<p>${escapeText(line)}</p>`).join("\n")}\n</blockquote>`;
}

/**
 * A note body with each quote replaced by its baked snapshot, or null when the
 * body's quotes aren't the ones resolved (a page edited since the registry
 * last made a version of it). `bake` may decorate each baked quote.
 */
export function withQuotes(html, quotes, bake = bakeQuote) {
  const found = quotesIn(html);
  if (found.length !== quotes.length || found.some((q, i) => q.slug !== quotes[i].slug)) return null;
  let i = 0;
  return html.replace(QUOTE_BLOCK, () => bake(quotes[i++]));
}

/** §5.1: "sha256:" + hex(SHA-256(content_md as UTF-8)). */
export const contentHash = (markdown) =>
  `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;

/** An endcap's content is empty (§9), and its hash is the hash of that. */
const WITHDRAWN_HASH = contentHash("");

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** §5.1: 128 random bits as 26 characters of lowercase Crockford base32. */
export function newId() {
  let bits = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id = CROCKFORD[Number(bits & 31n)] + id;
    bits >>= 5n;
  }
  return id;
}

/** §4: protocol timestamps are ISO 8601 UTC. Whole seconds, as the spec writes them. */
export const toUtc = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Brings the registry up to date with the published notes and reports what
 * happened. The registry is the only record of ids and version history —
 * neither can be recovered from the pages — so entries are only ever added to.
 *
 *   { items: { [slug]: { id, created, hash, withdrawn?, stub_of?, seen?, page?, moved_from?, generated?,
 *                        changelog: [{ version, at, note, pinned? }] } } }
 *
 * A note is a new version when its markdown hash changes, not when its page
 * does: the build rewrites prev/next links and motes re-renders pages, neither
 * of which is an edit. A new version is timed from the page when the page's
 * time has moved on, and from `now` otherwise (motes keeps a note's
 * published_time across updates).
 *
 * A note whose page asks for a pin (`note.pin`, see asksForPin) has its latest
 * version marked `pinned` — the one just captured, or the one already live when
 * the content hasn't changed (§8 rule 2 allows pinning after the fact). A pin
 * is never taken back, and a note that won't convert can't be pinned: there is
 * no trusted markdown to promise.
 *
 * A note that arrives with a resolved stub target (`note.stub`, a §5.9
 * reference; see stub.mjs) is registered as a stub of it (§10.6). That is
 * decided once, at registration, and never revisited: an item doesn't change
 * kind, and its body never transcludes the target, so §10.6's version
 * agreement keeps the reference at the value it was created with.
 *
 * A registered note whose page file has gone is withdrawn (§9): the protocol
 * has no delete, so taking the page down publishes an empty endcap version and
 * the entry stays, marked `withdrawn`. `present` is every slug with a file at
 * its path, whether or not it reads as a note, which is what tells a page
 * taken down from one that has merely stopped parsing — only the first is a
 * withdrawal. A withdrawn note whose page comes back is the item returning,
 * as the next version under the same id.
 *
 * kinocomputing never rewrites a source page, so a request can't be consumed
 * by taking it out. A note may instead carry `seen`, a fingerprint of its page
 * file: the registry keeps the fingerprint of the file it last registered, and
 * reads a pin or change-note request only from a file it hasn't seen. Without
 * `seen` every request is read, which is msn's behaviour (msn strips them).
 * A note may also carry `page`, where it is published, which the registry
 * follows; a page it moves away from is kept in `moved_from` for redirects.
 *
 * A note may carry `generated`, the model that wrote its page (§5.7). It is a
 * property of the version the page makes: recorded with that version's time
 * when one is made, dropped when a version is made without it, and never kept
 * on a withdrawal endcap.
 */
export function updateRegistry(registry, notes, { now, makeId = newId, present = new Set(), site = null }) {
  const items = structuredClone(registry.items ?? {});
  const events = [];
  const seen = new Set();
  const bySlug = new Map(notes.map((note) => [note.slug, note]));

  // A note that quotes is registered after every note that doesn't, so a
  // thread can quote a fragment published in the same act (§7: thread last).
  const quotes = (note) => (quotesIn(note.content).length ? 1 : 0);
  const ordered = [...notes].sort((a, b) => quotes(a) - quotes(b));

  for (const note of ordered) {
    seen.add(note.slug);
    const entry = items[note.slug];
    // Kind is the item's for life (§5.3): a stub is a thread, a page may ask to
    // be one when first registered, and everything else is a fragment.
    const kind = entry ? baseKind(entry) : note.stub || note.kind === "thread" ? "thread" : "fragment";
    if (entry && note.kind && note.kind !== kind) events.push({ type: "kind-kept", slug: note.slug, kind });

    // Quotes resolve against what is live now: a registered fragment whose page
    // still says what its latest version says (P22).
    const resolved = [];
    const resolve = (slug) => {
      const target = items[slug];
      const targetNote = bySlug.get(slug);
      if (!target || target.withdrawn) throw new Error(`quotes ${slug}, which isn't published`);
      if (baseKind(target) !== "fragment") throw new Error(`quotes ${slug}, a thread; only fragments are quoted here`);
      const live = targetNote && site && liveContent({ items }, targetNote, site);
      if (!live) throw new Error(`quotes ${slug}, whose page isn't its live version`);
      resolved.push({ slug, id: target.id, version: target.changelog.at(-1).version, html: live.html });
      return target.id;
    };
    let hash;
    try {
      const quoted = quotesIn(note.content);
      if (quoted.length && kind !== "thread") throw new Error("a fragment can't quote (§10.1); a quoting note is a thread");
      hash = contentHash(htmlToMarkdown(note.content, { quote: resolve }));
      quoted.forEach((q, i) => {
        if (!q.lines.length) return;
        const exact = q.lines.join("\n");
        if (!textContent(resolved[i].html).includes(exact)) throw new Error(`quotes ${q.slug} with a selection that isn't in it (§10.2)`);
        resolved[i].exact = exact;
      });
    } catch (error) {
      events.push({ type: "unconverted", slug: note.slug, reason: error.message });
      continue;
    }

    const fresh = note.seen === undefined || entry?.seen !== note.seen;
    if (!entry) {
      const created = toUtc(note.iso);
      items[note.slug] = {
        id: makeId(),
        created,
        hash,
        // Recorded only where it can't be derived: a stub is always a thread.
        ...(kind === "thread" && !note.stub ? { kind } : {}),
        ...(note.stub ? { stub_of: note.stub } : {}),
        ...(resolved.length ? { quotes: resolved } : {}),
        ...(note.generated ? { generated: { model: note.generated, at: created } } : {}),
        changelog: [{ version: 1, at: created, note: null }],
      };
      events.push({ type: "new", slug: note.slug });
      if (note.stub) events.push({ type: "stub", slug: note.slug, origin: note.stub.origin, id: note.stub.id });
    } else if (entry.hash !== hash || entry.withdrawn) {
      const last = entry.changelog.at(-1);
      const paged = toUtc(note.iso);
      const at = paged > last.at ? paged : toUtc(now);
      entry.hash = hash;
      delete entry.withdrawn;
      // A new version of a thread re-resolves every quote (§10.2 republish).
      if (resolved.length) entry.quotes = resolved;
      else delete entry.quotes;
      if (note.generated) entry.generated = { model: note.generated, at };
      else delete entry.generated;
      entry.changelog.push({
        version: last.version + 1,
        at,
        // What the publisher said changed, if it said. A first version has
        // nothing to compare against, so a note arriving with one is dropped.
        note: (fresh && note.changeNote) || null,
      });
      events.push({ type: "version", slug: note.slug, version: last.version + 1 });
    }

    if (note.pin && fresh) {
      const live = items[note.slug].changelog.at(-1);
      if (!live.pinned) {
        live.pinned = true;
        events.push({ type: "pinned", slug: note.slug, version: live.version });
      }
    }

    const current = items[note.slug];
    if (note.seen !== undefined) current.seen = note.seen;
    if (note.page && current.page !== note.page) {
      if (current.page) {
        current.moved_from = [...(current.moved_from ?? []).filter((page) => page !== note.page), current.page];
      }
      current.page = note.page;
    }
  }

  for (const [slug, entry] of Object.entries(items)) {
    if (seen.has(slug) || entry.withdrawn) continue;
    if (present.has(slug)) {
      // Still a file, no longer a note: someone's mistake, not a withdrawal.
      events.push({ type: "missing", slug });
      continue;
    }
    const version = entry.changelog.at(-1).version + 1;
    entry.changelog.push({ version, at: toUtc(now), note: null });
    entry.hash = WITHDRAWN_HASH;
    entry.withdrawn = true;
    delete entry.generated;
    delete entry.quotes;
    events.push({ type: "withdrawn", slug, version });
  }

  return { registry: { items }, events };
}

/** Sorted by slug so the file diffs cleanly whatever order notes were read in. */
export function serializeRegistry(registry) {
  const items = Object.fromEntries(
    Object.entries(registry.items).sort(([a], [b]) => a.localeCompare(b))
  );
  return `${JSON.stringify({ items }, null, 2)}\n`;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** The §5.7 disclosure for an entry's live version: the whole body, no sources declared. */
const generatedMembers = (entry) => (entry.generated
  ? { generated: [{ sources: [], model: entry.generated.model, at: entry.generated.at }] }
  : {});

/** A stub is a thread (§10.6); every other note is a fragment. */
/** The kind an item was born with (§5.3): recorded, or a stub's, or a fragment. */
export const baseKind = (entry) => entry.kind ?? (entry.stub_of ? "thread" : "fragment");

const kindOf = (entry) => (entry.withdrawn ? "withdrawn" : baseKind(entry));

/**
 * The thread-only members of a document (§10.3, §10.6): threads always carry
 * transclusions — one reference per quote, in order, with the selection for a
 * partial one — and a live or pinned stub carries its stub_of. An endcap keeps
 * an empty array and drops the reference, which is what stops it verifying.
 */
const threadMembers = (entry, { endcap = false } = {}) => (baseKind(entry) === "thread"
  ? {
    transclusions: endcap ? [] : (entry.quotes ?? []).map((q) => ({
      id: q.id, version: q.version, ...(q.exact !== undefined ? { selector: { exact: q.exact } } : {}),
    })),
    ...(entry.stub_of && !endcap ? { stub_of: entry.stub_of } : {}),
  }
  : {});

const BLYG_NS = "https://blygger.org/ns/0.1";
const FEED_LIMIT = 50;
const EXCERPT_LENGTH = 60;

const escapeXml = (text) => text
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** The opening words of a note as plain text, for the derived feed title (§7). */
export function excerpt(html) {
  // Inline tags vanish; block tags leave a space, so paragraphs don't run together.
  const text = decodeEntities(
    html.replace(/<\/?(?:a|em|i|strong|b|del|s|strike|code)(?:\s[^>]*)?>/g, "").replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH + 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}…`;
}

/**
 * RSS 2.0 with the blyg: namespace (§7): one entry per publish event, newest
 * first, each carrying its note's latest content. An edited note therefore
 * appears once per recent version, under a per-version guid, which is what
 * makes an edit resurface in a plain RSS reader. lastBuildDate is the latest
 * event's time, not the build's, so an unchanged feed stays byte-identical.
 *
 * A withdrawn note is the exception: it has exactly one entry, its withdrawal,
 * titled `withdrawn` and empty. Its earlier events are dropped, since with the
 * content gone they would have nothing to show.
 */
function renderFeed(published, site) {
  const events = published
    .flatMap((item) => (item.withdrawn ? item.entry.changelog.slice(-1) : item.entry.changelog)
      .map((event) => ({ ...item, event })))
    .sort((a, b) => b.event.at.localeCompare(a.event.at)
      || b.slug.localeCompare(a.slug)
      || b.event.version - a.event.version)
    .slice(0, FEED_LIMIT);

  const items = events.map(({ entry, slug, html, withdrawn, event }) => {
    const title = withdrawn ? "withdrawn"
      : event.note ? `${event.note} — ${excerpt(html)}` : excerpt(html);
    return [
      "    <item>",
      `      <guid isPermaLink="false">blyg:${entry.id}:v${event.version}</guid>`,
      `      <link>${escapeXml(`${site.origin}${entry.page ?? slug}`)}</link>`,
      `      <title>${escapeXml(title)}</title>`,
      `      <description><![CDATA[${html.replaceAll("]]>", "]]]]><![CDATA[>")}]]></description>`,
      `      <pubDate>${new Date(event.at).toUTCString()}</pubDate>`,
      ...(site.author?.name ? [`      <dc:creator>${escapeXml(site.author.name)}</dc:creator>`] : []),
      `      <blyg:id>${entry.id}</blyg:id>`,
      `      <blyg:kind>${kindOf(entry)}</blyg:kind>`,
      `      <blyg:version>${event.version}</blyg:version>`,
      `      <blyg:created>${entry.created}</blyg:created>`,
      `      <blyg:item>${site.origin}items/${entry.id}.json</blyg:item>`,
      "    </item>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0" xmlns:blyg="${BLYG_NS}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">`,
    "  <channel>",
    `    <title>${escapeXml(site.title)}</title>`,
    `    <link>${escapeXml(site.origin)}</link>`,
    `    <description>${escapeXml(site.description)}</description>`,
    "    <language>en</language>",
    ...(events.length ? [`    <lastBuildDate>${new Date(events[0].event.at).toUTCString()}</lastBuildDate>`] : []),
    `    <atom:link href="${escapeXml(`${site.origin}feed.xml`)}" rel="self" type="application/rss+xml"/>`,
    "    <blyg:level>2</blyg:level>",
    `    <blyg:manifest>${escapeXml(`${site.origin}blyg.json`)}</blyg:manifest>`,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

/**
 * HTML with every href and src made absolute (§5.2, decision #53): the same
 * bytes travel as the feed description, into importers' stores and into other
 * origins' threads, none of which has a page to resolve against. Relative
 * URLs — root-relative, path-relative, fragment- or query-only — resolve
 * against `base`, the item's own page. Absolute ones, mailto: and the like are
 * left exactly as written.
 */
export function absolutize(html, base) {
  return html.replace(/(\s(?:href|src))="([^"]*)"/g, (whole, attr, url) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return whole;
    try {
      const resolved = new URL(url.replace(/&amp;/g, "&"), base).href;
      return `${attr}="${resolved.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
    } catch {
      return whole;
    }
  });
}

/**
 * A note's content as its registry entry's latest version, or null when the
 * two don't match: the note isn't registered, or it failed to convert and so
 * no version was recorded for what the page now says.
 */
function liveContent(registry, note, site) {
  const entry = registry.items[note.slug];
  if (!entry) return null;
  let markdown;
  try {
    // Ids never change, so the quotes resolve to what they did when the version was made.
    markdown = htmlToMarkdown(note.content, { quote: (slug) => {
      if (!registry.items[slug]) throw new Error(`quotes ${slug}, which isn't registered`);
      return registry.items[slug].id;
    } });
  } catch {
    return null;
  }
  if (contentHash(markdown) !== entry.hash) return null;
  // A quote shows the snapshot taken when the version was made (§10.2), not
  // what its source says now.
  const baked = entry.quotes?.length ? withQuotes(note.content, entry.quotes) : note.content;
  if (baked === null) return null;
  const html = absolutize(baked, new URL(entry.page ?? note.slug, site.origin).href);
  // A machine-written version's HTML says so in the wire's own token (§5.7).
  return { entry, markdown, html: entry.generated ? `<div class="blyg-tk-gen">\n${html}\n</div>` : html };
}

/**
 * The static protocol surface (§4), as file contents keyed by path relative to
 * the origin: the manifest, the feed, the archive index and one item document
 * per note.
 *
 * `site` is { origin, title, description, author, generator, generatorUrl }.
 * A note whose content doesn't match its registry entry (it failed to
 * convert, so no version was recorded) gets no document written, which leaves
 * the last good one in place, and is left out of the feed. A withdrawn note
 * has no page to read and needs none: its document is written from the
 * registry alone.
 */
export function buildSurfaces(registry, notes, site) {
  const files = new Map();
  const updatedOf = (entry) => entry.changelog.at(-1).at;
  const published = [];

  for (const note of notes) {
    const live = liveContent(registry, note, site);
    if (!live) continue;
    const { entry, markdown, html } = live;
    published.push({ entry, slug: note.slug, html });

    files.set(`items/${entry.id}.json`, json({
      blyg: BLYG_VERSION,
      id: entry.id,
      kind: kindOf(entry),
      origin: site.origin,
      page: entry.page ?? note.slug,
      author: site.author,
      created: entry.created,
      updated: updatedOf(entry),
      version: entry.changelog.at(-1).version,
      content_md: markdown,
      content_html: html,
      content_hash: entry.hash,
      media: [],
      ...threadMembers(entry),
      ...generatedMembers(entry),
      changelog: entry.changelog,
    }));
  }

  // A withdrawn note keeps its document, emptied (§9): the endcap says the
  // item existed and where it lived, and nothing of what it said.
  for (const [slug, entry] of Object.entries(registry.items)) {
    if (!entry.withdrawn) continue;
    published.push({ entry, slug, html: "", withdrawn: true });
    files.set(`items/${entry.id}.json`, json({
      blyg: BLYG_VERSION,
      id: entry.id,
      kind: "withdrawn",
      origin: site.origin,
      page: entry.page ?? slug,
      author: site.author,
      created: entry.created,
      updated: updatedOf(entry),
      version: entry.changelog.at(-1).version,
      content_md: "",
      content_html: "",
      content_hash: entry.hash,
      media: [],
      ...threadMembers(entry, { endcap: true }),
      changelog: entry.changelog,
    }));
  }

  // Every item ever registered, page or no page: the index is the lossless
  // surface (§6.2), newest update first.
  const index = Object.values(registry.items)
    .map((entry) => ({
      id: entry.id,
      kind: kindOf(entry),
      created: entry.created,
      updated: updatedOf(entry),
      version: entry.changelog.at(-1).version,
    }))
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  const updated = index[0]?.updated;

  files.set("items/index.json", json({ updated, items: index }));
  files.set("feed.xml", renderFeed(published, site));
  files.set("blyg.json", json({
    blyg: BLYG_VERSION,
    // `page` is an L2 construct; nothing else from L2 is emitted (§3).
    level: 2,
    generator: site.generator,
    generator_url: site.generatorUrl,
    site: site.origin,
    title: site.title,
    author: site.author,
    feed: "feed.xml",
    items: "items/index.json",
    // Curated lists over other people's pages (§6.1): a client construct, so
    // no item ever names one.
    ...(site.hoppers?.length ? { hoppers: site.hoppers } : {}),
    updated,
  }));

  return files;
}

/**
 * The pinned-version documents (§8) that can be written from the pages as they
 * stand: one per note whose live version is pinned, keyed by path relative to
 * the origin, each with the slug it belongs to.
 *
 * Only the live version's content is ever in hand, so a pin's document can
 * only be made while its version is the live one — which is when the pin is
 * taken. These files are a promise about exact bytes: the caller writes one
 * that doesn't exist yet and never touches one that does. The frozen page
 * beside it is another matter: it is rebuilt from this document on every run,
 * so its chrome can change while the content it shows cannot.
 */
export function buildPins(registry, notes, site) {
  const pins = [];
  for (const note of notes) {
    const live = liveContent(registry, note, site);
    const event = live?.entry.changelog.at(-1);
    if (!event?.pinned) continue;
    const { entry, markdown, html } = live;
    pins.push({
      slug: note.slug,
      version: event.version,
      at: event.at,
      file: `items/${entry.id}/v${event.version}.json`,
      content: json({
        blyg: BLYG_VERSION,
        id: entry.id,
        kind: kindOf(entry),
        version: event.version,
        at: event.at,
        note: event.note,
        pinned: true,
        origin: site.origin,
        author: site.author,
        content_md: markdown,
        content_html: html,
        content_hash: entry.hash,
        ...threadMembers(entry),
        ...generatedMembers(entry),
      }),
    });
  }
  return pins;
}

const PIN_REQUEST = /<meta name="blyg:pin"[^>]*>/;

/**
 * Whether a note page asks for its version to be pinned. The publisher can't
 * pin by itself — it knows neither the note's id nor its version number — so
 * it leaves `<meta name="blyg:pin" content="true">` in the page it writes, and
 * the build does the pinning. Only `true` counts: a publisher that copies the
 * template without filling it (Subset's receiver) leaves `content="{{pin}}"`.
 */
export const asksForPin = (html) => /<meta name="blyg:pin" content="true"[^>]*>/.test(html);

/**
 * Takes the pin request back out of a page once it has been honoured. Left in,
 * it would pin the next version too, whenever something other than its
 * publisher — a converter change, a hand edit — produced one.
 */
export const withoutPinRequest = (html) => html
  .replace(/^[ \t]*<meta name="blyg:pin"[^>]*>\n/m, "")
  .replace(PIN_REQUEST, "");

const CHANGE_NOTE = /<meta name="blyg:note" content="([^"]*)"[^>]*>/;

/**
 * What a publisher says changed in the version its page makes, from
 * `<meta name="blyg:note" content="…">`, or null. It becomes that version's
 * changelog note (§5.2), which the feed puts ahead of the excerpt in the entry's
 * title (§7). An unfilled template placeholder doesn't count.
 */
export function changeNoteOf(html) {
  const raw = html.match(CHANGE_NOTE)?.[1];
  if (!raw || raw.includes("{{")) return null;
  let text;
  try {
    text = decodeEntities(raw);
  } catch {
    text = raw;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * Takes the change note back out of a page once the build has read it, for the
 * same reason as a pin request: left in, it would be attached to the next
 * version whatever made that one.
 */
export const withoutChangeNote = (html) => html
  .replace(/^[ \t]*<meta name="blyg:note"[^>]*>\n/m, "")
  .replace(CHANGE_NOTE, "");

const escapeHtml = (text) => text
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A version's change note as it follows the version's number in a footer. */
const noteSuffix = (event) => (event.note
  ? ` <em class="change-note">— ${escapeHtml(event.note)}</em>` : "");

/**
 * The version list for a pinned version's frozen page, in two halves that go
 * either side of the page's own timestamp: everything up to and including the
 * version being shown, in bold, and everything after it.
 *
 *   v1 · **v2** · [3 Oct 2026, 18:59] · v4 · v5
 *
 * As on the live page, only what the origin promises forever is listed (§8.4):
 * the pinned versions, each a link to its frozen page, and the live version, a
 * link to the note itself. When the version shown is also the live one its
 * bold number carries that link, which is the way back to the note. A
 * withdrawn note has no live version, and the word stands in for it.
 */
export function renderPinnedVersions(entry, path, version) {
  const last = entry.changelog.at(-1);
  const live = entry.withdrawn ? null : last.version;
  const link = (href, label) => `<a href="${href}" target="_self">${label}</a>`;
  const items = entry.changelog
    .filter((event) => event.pinned || event.version === live)
    .map((event) => {
      const label = `v${event.version}`;
      if (event.version === version) {
        const bold = `<strong>${label}</strong>`;
        return { current: true,
          html: (event.version === live ? link(path, bold) : bold) + noteSuffix(event) };
      }
      return { html: link(event.version === live ? path : pinnedPath(path, event.version), label) };
    });
  if (entry.withdrawn) items.push({ html: link(path, "withdrawn") });

  const at = items.findIndex((item) => item.current);
  const join = (part) => part.map((item) => item.html).join(" · ");
  const after = items.slice(at + 1);
  return {
    before: `<span class="versions">${join(items.slice(0, at + 1))} · </span>`,
    after: after.length ? `<span class="versions"> · ${join(after)}</span>` : "",
  };
}

/** Puts the two halves of a version list either side of the footer stamp's time. */
export function withPinnedVersions(html, { before, after }) {
  const footer = html.indexOf("</main>");
  if (footer === -1) return html;
  return html.slice(0, footer) + html.slice(footer).replace(
    /(<p class="stamp">)(.*?)(<\/p>)/s,
    (whole, open, time, close) => `${open}${before}${time}${after}${close}`
  );
}

const HEAD_LINK = /^[ \t]*<link rel="(?:blyg"|alternate" type="application\/json")[^>]*>\n/gm;

/**
 * Sets a note page's discovery links: rel="blyg" to the origin (§12.1) and the
 * way back from the page to its item document (§5.8). Replaces any already
 * there, so a page motes has re-rendered without them gets them again.
 */
export function withHeadLinks(html, originPath, id) {
  const links = [
    `    <link rel="blyg" href="${originPath}">`,
    `    <link rel="alternate" type="application/json" href="${originPath}items/${id}.json">`,
  ].join("\n");
  const stripped = html.replace(HEAD_LINK, "");
  const head = stripped.indexOf("</head>");
  if (head === -1) return html;
  return `${stripped.slice(0, head)}${links}\n${stripped.slice(head)}`;
}

/**
 * When a note last changed: its latest version's time once that has moved
 * away from the page's own time (motes keeps published_time across updates),
 * and the page's time, exactly as written, until then.
 */
export function latestTime(registry, note) {
  const at = registry.items[note.slug]?.changelog.at(-1).at;
  return at && at !== toUtc(note.iso) ? at : note.iso;
}

/**
 * Sets the time shown in a note page's footer stamp, leaving the page's
 * published_time alone: that stays the time the note was first published.
 */
export function withStamp(html, datetime, display) {
  const footer = html.indexOf("</main>");
  if (footer === -1) return html;
  const stamped = html.slice(footer).replace(
    /(<p class="stamp">.*?<time datetime=")[^"]*(">)[^<]*(<\/time>)/,
    (whole, open, mid, close) => `${open}${datetime}${mid}${display}${close}`
  );
  return html.slice(0, footer) + stamped;
}

/** Where a pinned version's frozen page lives, beside the live page. */
export const pinnedPath = (path, version) => `${path}-v${version}`;

/**
 * The version links for a note page: pinned versions as links to their frozen
 * pages, the live version in bold — and a link too when it is itself pinned.
 * §8.4 allows a version display to offer only what the origin already promises
 * forever, so unpinned history isn't listed. Empty for a note still at an
 * unpinned v1, where there is nothing to say.
 */
export function renderVersions(entry, path) {
  const last = entry.changelog.at(-1);
  const live = last.version;
  if (live === 1 && !last.pinned) return "";
  const link = (version, label) =>
    `<a href="${pinnedPath(path, version)}" target="_self">${label}</a>`;
  const pinned = entry.changelog
    .filter((event) => event.pinned && event.version !== live)
    .map((event) => link(event.version, `v${event.version}`));
  const bold = `<strong>v${live}</strong>`;
  const current = (last.pinned ? link(live, bold) : bold) + noteSuffix(last);
  return `<span class="versions">${[...pinned, current].join(" · ")} · </span>`;
}

/**
 * What stands where the version links would on a withdrawn note's page: the
 * word, after links to whatever was pinned. Those are promised forever (§8),
 * withdrawal or no, and this page is now the only place that cites them.
 */
export function renderWithdrawn(entry, path) {
  const pinned = entry.changelog
    .filter((event) => event.pinned)
    .map((event) => `<a href="${pinnedPath(path, event.version)}" target="_self">v${event.version}</a>`);
  return `<span class="versions">${[...pinned, "withdrawn"].join(" · ")} · </span>`;
}

/**
 * Sets the version links in the page's footer stamp, ahead of the time: the
 * time is the live version's. Replaces any already on the page, wherever its
 * chrome carried them; an empty string removes them.
 */
export function withVersions(html, rendered) {
  const start = html.indexOf("<main>");
  const end = html.indexOf("</main>");
  if (start === -1 || end === -1) return html;
  const strip = (chrome) => chrome.replace(/<span class="versions">.*?<\/span>/gs, "");
  const footer = strip(html.slice(end)).replace('<p class="stamp">', `<p class="stamp">${rendered}`);
  return strip(html.slice(0, start)) + html.slice(start, end) + footer;
}
