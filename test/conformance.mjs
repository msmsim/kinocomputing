// The publish-side MUSTs of Blygger 0.3 (§4–§9), checked on a deployed tree.
// Written from the spec text, not from the build, so it is a second opinion on
// anything the model and the build might agree about wrongly. Returns a list
// of violations; empty means conformant as far as these rules reach.

import { createHash } from "node:crypto";

export const ORIGIN = "https://www.kinocomputing.com/";
const ID = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KINDS = new Set(["fragment", "thread", "withdrawn"]);
const hash = (md) => `sha256:${createHash("sha256").update(md, "utf8").digest("hex")}`;

/** Every href/src in some HTML that isn't absolute (§5.2, decision #53). */
const relativeUrls = (html) => [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)]
  .map((m) => m[1]).filter((url) => !/^[a-z][a-z0-9+.-]*:/i.test(url));

function feedEntries(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, body]) => {
    const tag = (name) => body.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
    const description = tag("description") ?? "";
    return {
      guid: tag("guid"),
      title: tag("title"),
      link: tag("link"),
      id: tag("blyg:id"),
      version: Number(tag("blyg:version")),
      kind: tag("blyg:kind"),
      pubDate: tag("pubDate"),
      html: description.replace(/^<!\[CDATA\[|\]\]>$/g, "").replaceAll("]]]]><![CDATA[>", "]]>"),
    };
  });
}

export function conformance(tree) {
  const bad = [];
  const say = (where, what) => bad.push(`${where}: ${what}`);
  const read = (path) => (tree.has(path) ? JSON.parse(tree.get(path)) : null);

  const manifest = read("blyg.json");
  const index = read("items/index.json");
  if (!manifest) say("blyg.json", "missing (§4)");
  if (!index) say("items/index.json", "missing (§4)");
  if (!tree.has("feed.xml")) say("feed.xml", "missing (§4)");
  if (!manifest || !index || !tree.has("feed.xml")) return bad;

  if (manifest.blyg !== "0.3") say("blyg.json", `blyg is ${manifest.blyg}`);
  if (manifest.feed !== "feed.xml") say("blyg.json", "feed is not feed.xml");
  if (manifest.items !== "items/index.json") say("blyg.json", "items is not items/index.json");
  if (manifest.updated !== index.updated) say("blyg.json", "updated disagrees with the index");

  const docs = new Map();
  for (const [path, text] of tree) {
    const m = path.match(/^items\/([^/]+)\.json$/);
    if (m && m[1] !== "index") docs.set(m[1], JSON.parse(text));
  }

  for (const [name, doc] of docs) {
    const at = `items/${name}.json`;
    if (!ID.test(doc.id)) say(at, `id ${doc.id} is not 26 Crockford base32 (§5.1)`);
    if (doc.id !== name) say(at, "served at a path that isn't its id");
    if (doc.blyg !== "0.3") say(at, `blyg is ${doc.blyg}`);
    if (!KINDS.has(doc.kind)) say(at, `kind ${doc.kind}`);
    if (doc.origin !== ORIGIN) say(at, `origin ${doc.origin}`);
    if (typeof doc.page !== "string" || !doc.page) say(at, "no page (§5.8)");
    if (doc.content_hash !== hash(doc.content_md ?? "")) say(at, "content_hash is not sha256 of content_md (§5.1)");
    const log = doc.changelog ?? [];
    log.forEach((entry, i) => {
      if (entry.version !== i + 1) say(at, `changelog entry ${i} is v${entry.version} (§5.2: +1 per event)`);
      if (!UTC.test(entry.at)) say(at, `changelog v${entry.version} at ${entry.at} is not UTC (§4)`);
    });
    if (doc.version !== log.at(-1)?.version) say(at, "version is not the last changelog entry's");
    if (doc.updated !== log.at(-1)?.at) say(at, "updated is not the last changelog entry's at (§5.2)");
    if (!UTC.test(doc.created) || !UTC.test(doc.updated)) say(at, "created/updated not UTC (§4)");
    for (const url of relativeUrls(doc.content_html ?? "")) say(at, `relative URL ${url} in content_html (§5.2)`);
    if (doc.generated !== undefined) {
      if (!Array.isArray(doc.generated) || !doc.generated.every((g) => Array.isArray(g.sources))) say(at, "generated is not an array of entries with sources (§5.7)");
      if (!(doc.content_html ?? "").includes('class="blyg-tk-gen"')) say(at, "generated, but no blyg-tk-gen span in content_html (§5.7)");
    }
    if (doc.kind === "withdrawn") {
      if ("generated" in doc) say(at, "withdrawn but carries generated (§5.7 rule 4)");
      if (doc.content_md !== "" || doc.content_html !== "") say(at, "withdrawn but not empty (§9)");
      if ((doc.media ?? []).length) say(at, "withdrawn with media (§9)");
      if (log.at(-1)?.pinned) say(at, "endcap is pinned (§8 rule 2)");
      if ("stub_of" in doc) say(at, "withdrawn but keeps stub_of (§9)");
    }

    for (const entry of log.filter((e) => e.pinned)) {
      const pinPath = `items/${doc.id}/v${entry.version}.json`;
      const pin = read(pinPath);
      if (!pin) { say(pinPath, "pinned in the changelog but not served (§8)"); continue; }
      if (pin.id !== doc.id || pin.version !== entry.version || pin.pinned !== true) say(pinPath, "identity disagrees with its path");
      if (pin.content_hash !== hash(pin.content_md ?? "")) say(pinPath, "content_hash is not sha256 of content_md");
      if (pin.kind === "withdrawn") say(pinPath, "a pinned endcap (§8 rule 2)");
      if (pin.at !== entry.at) say(pinPath, "at disagrees with the changelog");
      for (const url of relativeUrls(pin.content_html ?? "")) say(pinPath, `relative URL ${url}`);
    }
  }
  for (const path of tree.keys()) {
    const m = path.match(/^items\/([^/]+)\/v(\d+)\.json$/);
    if (!m) continue;
    const entry = docs.get(m[1])?.changelog?.find((e) => e.version === Number(m[2]));
    if (!entry?.pinned) say(path, "served, but that version isn't pinned (§4, §8)");
  }

  // Threads and transclusion (§10). Own-origin only: kinocomputing quotes itself.
  for (const [name, doc] of docs) {
    const at = `items/${name}.json`;
    for (const [where, d] of [[at, doc], ...(doc.changelog ?? []).filter((e) => e.pinned)
      .map((e) => [`items/${name}/v${e.version}.json`, read(`items/${name}/v${e.version}.json`)]).filter(([, p]) => p)]) {
      checkTransclusions(where, d, docs, read, say);
    }
  }

  const listed = new Set(index.items.map((item) => item.id));
  for (const id of docs.keys()) if (!listed.has(id)) say("items/index.json", `${id} is missing (§6.2)`);
  for (const item of index.items) {
    const doc = docs.get(item.id);
    if (!doc) { say("items/index.json", `lists ${item.id}, which has no document`); continue; }
    for (const key of ["kind", "version", "created", "updated"]) {
      if (item[key] !== doc[key]) say("items/index.json", `${item.id} ${key} disagrees with its document`);
    }
  }
  index.items.forEach((item, i) => {
    if (i && index.items[i - 1].updated < item.updated) say("items/index.json", "not ordered by updated descending (§6.2)");
  });
  if (index.items.length && index.updated !== index.items[0].updated) say("items/index.json", "updated is not the newest item's");

  const xml = tree.get("feed.xml");
  if (!xml.includes(`<blyg:manifest>${ORIGIN}blyg.json</blyg:manifest>`)) say("feed.xml", "no <blyg:manifest> (§7)");
  if (!xml.includes('xmlns:blyg="https://blygger.org/ns/0.1"')) say("feed.xml", "wrong or missing blyg namespace (§7)");
  const entries = feedEntries(xml);
  if (entries.length > 50) say("feed.xml", `${entries.length} entries, over the window`);
  const perItem = new Map();
  entries.forEach((entry, i) => {
    if (entry.guid !== `blyg:${entry.id}:v${entry.version}`) say("feed.xml", `guid ${entry.guid} is not blyg:{id}:v{n} (§7)`);
    const doc = docs.get(entry.id);
    if (!doc) { say("feed.xml", `entry for ${entry.id}, which has no document`); return; }
    if (entry.html !== doc.content_html) say("feed.xml", `${entry.guid} doesn't carry the latest content (§7)`);
    if (doc.kind === "withdrawn" && entry.title !== "withdrawn") say("feed.xml", `${entry.guid} withdrawn but titled ${entry.title}`);
    if (!entry.title) say("feed.xml", `${entry.guid} has no title (§7)`);
    if (!entry.link?.startsWith(ORIGIN)) say("feed.xml", `${entry.guid} link isn't absolute`);
    perItem.set(entry.id, (perItem.get(entry.id) ?? 0) + 1);
    if (i && new Date(entries[i - 1].pubDate) < new Date(entry.pubDate)) say("feed.xml", "not newest first (§7)");
  });
  for (const [id, count] of perItem) {
    if (docs.get(id)?.kind === "withdrawn" && count !== 1) say("feed.xml", `withdrawn ${id} has ${count} entries (§7)`);
  }
  return bad;
}

const DECODE = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39|apos);/g, (whole, name) => DECODE[name]);

/** §2: tags stripped, whitespace collapsed, block boundaries as line breaks. */
export function textContent(html) {
  return decode(html.replace(/<\/(?:p|h[1-6]|li|blockquote|pre|div)>|<br\s*\/?>|<hr\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** The baked transclusions in some HTML, in order, with each one's inner HTML. */
function baked(html) {
  const out = [];
  const open = /<blockquote class="blyg-transclusion( blyg-partial)?" data-blyg-id="([^"]+)" data-blyg-version="(\d+)"[^>]*>/g;
  for (let m; (m = open.exec(html));) {
    // The matching close: count nested blockquotes from here.
    let depth = 1;
    const tags = /<(\/?)blockquote\b[^>]*>/g;
    tags.lastIndex = open.lastIndex;
    let t;
    while (depth && (t = tags.exec(html))) depth += t[1] ? -1 : 1;
    const inner = html.slice(open.lastIndex, t ? t.index : html.length);
    out.push({ partial: !!m[1], id: m[2], version: Number(m[3]), inner: inner.replace(/^\n|\n$/g, "") });
    open.lastIndex = t ? tags.lastIndex : html.length;
  }
  return out;
}

/**
 * §10.1–§10.3 for one document or pin: a fragment quotes nothing; a thread's
 * `transclusions` are its directives, in order, each baked as the snapshot of
 * an item this origin serves, whole or by a selection found in it.
 */
function checkTransclusions(where, doc, docs, read, say) {
  const directives = [...(doc.content_md ?? "").matchAll(/^!\[\[([^\]|]+)\]\]\s*$/gm)].map((m) => m[1]);
  const quoted = baked(doc.content_html ?? "");
  if (doc.kind === "fragment") {
    if ("transclusions" in doc) say(where, "a fragment with transclusions (§10.3)");
    if (directives.length || quoted.length) say(where, "a fragment that quotes (§10.1)");
    return;
  }
  if (doc.kind === "withdrawn") {
    if ("transclusions" in doc && doc.transclusions.length) say(where, "an endcap with transclusions (§9)");
    return;
  }
  if (!Array.isArray(doc.transclusions)) { say(where, "a thread without a transclusions array (§10.3)"); return; }
  const refs = doc.transclusions;
  if (refs.length !== directives.length || refs.some((r, i) => r.id !== directives[i])) say(where, "transclusions aren't its directives, in order (§10.3)");
  if (refs.length !== quoted.length) { say(where, `${refs.length} transclusions, ${quoted.length} baked`); return; }
  refs.forEach((ref, i) => {
    const q = quoted[i];
    if (q.id !== ref.id || q.version !== ref.version) say(where, `transclusion ${i} is baked as ${q.id} v${q.version}, declared ${ref.id} v${ref.version}`);
    if (q.partial !== (ref.selector !== undefined)) say(where, `transclusion ${i}: partial in one place and not the other (§10.3)`);
    if (q.partial && decode(q.inner.replace(/<\/p>\n?/g, "\n").replace(/<p>/g, "")).trim() !== ref.selector?.exact) say(where, `transclusion ${i}: the baked selection isn't selector.exact`);
    if ("origin" in ref) say(where, `transclusion ${i} names an origin; kinocomputing quotes only itself`);
    const target = docs.get(ref.id);
    if (!target) { say(where, `transclusion ${i} quotes ${ref.id}, which this origin doesn't serve`); return; }
    if (ref.id === doc.id) say(where, "quotes itself");
    // The snapshot can be checked while its version is served: live, or pinned.
    const source = target.version === ref.version && target.kind !== "withdrawn" ? target : read(`items/${ref.id}/v${ref.version}.json`);
    if (!source) return;
    if (source.kind === "thread") say(where, `transclusion ${i} quotes a thread; kinocomputing quotes fragments`);
    if (q.partial) {
      if (!textContent(source.content_html).includes(ref.selector.exact)) say(where, `transclusion ${i}: selection not in ${ref.id} v${ref.version} (§10.2)`);
    } else if (q.inner !== source.content_html) say(where, `transclusion ${i}: not ${ref.id} v${ref.version}'s content_html (§10.2)`);
  });
}

export { feedEntries, hash };
