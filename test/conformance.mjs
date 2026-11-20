// The publish-side MUSTs of Blygger 0.3 (§4–§9), checked on a deployed tree.
// Written from the spec text, not from the build, so it is a second opinion on
// anything the model and the build might agree about wrongly. Returns a list
// of violations; empty means conformant as far as these rules reach.

import { createHash } from "node:crypto";

const ORIGIN = "https://kinocomputing.com/";
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
    if (doc.kind === "withdrawn") {
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

export { feedEntries, hash };
