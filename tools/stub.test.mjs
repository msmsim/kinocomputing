// node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { stubTarget, resolveStub, normalizeOrigin } from "./stub.mjs";

const ID = "6cjkc91fsp0pqaw37gzacxksgk";
const ORIGIN = "https://blyg.example.org/";
const PAGE = `${ORIGIN}t/${ID}`;
const DOC_URL = `${ORIGIN}items/${ID}.json`;
const NOW = new Date("2026-10-18T12:00:00Z");

const doc = (overrides = {}) => ({
  blyg: "0.4", id: ID, kind: "thread", origin: ORIGIN, page: `t/${ID}`, version: 3,
  author: { name: "Their Author" },
  content_md: "Body.", content_html: "<p>Stigmergy is what a protocol looks like &amp; from inside.</p>",
  ...overrides,
});
const manifest = (overrides = {}) => ({ blyg: "0.4", level: 2, title: "Their Blyg", webmention: "webmention", ...overrides });
const pageHtml = (href = DOC_URL) =>
  `<html><head><link rel="alternate" type="application/rss+xml" href="${ORIGIN}feed.xml">\n`
  + `<link href="${href}" type="application/json" rel="alternate"></head><body></body></html>`;

/**
 * A fetch over a fixed table: url → { body, type?, status?, redirect? }.
 * A redirect is followed as fetch does, and the response's url is the final one.
 */
function network(table) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    let at = url;
    for (let hops = 0; table[at]?.redirect; hops += 1) at = table[at].redirect;
    const entry = table[at];
    if (!entry) return { ok: false, status: 404, url: at, headers: new Map(), text: async () => "" };
    const body = typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
    const status = entry.status ?? 200;
    return {
      ok: status < 300, status, url: at,
      headers: new Map([["content-type", entry.type ?? (typeof entry.body === "string" ? "text/html" : "application/json")]]),
      text: async () => body,
    };
  };
  return { fetch, calls };
}

const happy = (overrides = {}) => ({
  [PAGE]: { body: pageHtml() },
  [DOC_URL]: { body: doc() },
  [`${ORIGIN}blyg.json`]: { body: manifest() },
  ...overrides,
});

test("a Subset share's target is its source link; anything else has none", () => {
  const share = '<blockquote><p>Quote.</p></blockquote>\n<p class="source"><a href="https://x.org/t/1?a=1&amp;b=2">Title ↗</a></p>';
  assert.equal(stubTarget(share), "https://x.org/t/1?a=1&b=2");
  assert.equal(stubTarget('<p>A <a href="https://x.org/t/1">link</a> in prose.</p>'), null);
  assert.equal(stubTarget('<p class="source"><a href="/notes/a">Own ↗</a></p>'), null);
});

test("a blyg item page resolves to a reference with a frozen citation", async () => {
  const { fetch, calls } = network(happy());
  const reference = await resolveStub(PAGE, { fetch, now: NOW });
  assert.deepEqual(reference, {
    origin: ORIGIN,
    id: ID,
    version: 3,
    cited: {
      source: "Their Blyg",
      author: "Their Author",
      excerpt: "Stigmergy is what a protocol looks like & from inside.",
      url: PAGE,
      retrieved: "2026-10-18T12:00:00Z",
    },
  });
  assert.deepEqual(calls, [PAGE, DOC_URL, `${ORIGIN}blyg.json`]);
});

test("the item document's own url resolves too, and an absolute page is taken as given", async () => {
  const { fetch } = network(happy({ [DOC_URL]: { body: doc({ page: "https://elsewhere.example.org/p/1" }) } }));
  const reference = await resolveStub(DOC_URL, { fetch, now: NOW });
  assert.equal(reference.cited.url, "https://elsewhere.example.org/p/1");
});

test("a long excerpt is capped near 200 characters at a word", async () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const { fetch } = network(happy({ [DOC_URL]: { body: doc({ content_html: `<p>${words}</p>` }) } }));
  const { cited } = await resolveStub(PAGE, { fetch, now: NOW });
  assert.ok(cited.excerpt.length <= 201 && cited.excerpt.endsWith("…"), cited.excerpt);
});

test("the origin is where the manifest was fetched from, compared normalised", async () => {
  assert.equal(normalizeOrigin("HTTPS://Blyg.Example.org:443/blyg"), "https://blyg.example.org/blyg/");
  const { fetch } = network(happy({ [DOC_URL]: { body: doc({ origin: "https://BLYG.example.org" }) } }));
  assert.equal((await resolveStub(PAGE, { fetch, now: NOW })).origin, ORIGIN);
});

test("a manifest item template places the document; the default path is then not required", async () => {
  const placed = `${ORIGIN}api/items?id=${ID}`;
  const { fetch } = network(happy({
    [PAGE]: { body: pageHtml(placed) },
    [placed]: { body: doc() },
    [`${ORIGIN}blyg.json`]: { body: manifest({ item: "api/items?id={id}" }) },
  }));
  assert.equal((await resolveStub(PAGE, { fetch, now: NOW })).id, ID);
});

test("anything that isn't verifiably the origin's own live document is refused", async () => {
  const refuses = async (table, pattern, url = PAGE) => {
    const { fetch } = network(table);
    await assert.rejects(resolveStub(url, { fetch, now: NOW }), pattern);
  };
  await refuses(happy({ [PAGE]: { body: "<html><head></head></html>" } }), /no item document/);
  await refuses(happy({ [PAGE]: { body: "<html>", status: 500 } }), /500/);
  await refuses(happy({ [DOC_URL]: { body: { hello: "world" } } }), /not a blyg item document/);
  // A mirror serving someone else's document under its own path.
  const mirror = "https://mirror.example.net/items/x.json";
  await refuses(happy({ [PAGE]: { body: pageHtml(mirror) }, [mirror]: { body: doc() } }), /not served from its origin/);
  // A pinned version file is not the live document (§15.4).
  const pinned = `${ORIGIN}items/${ID}/v1.json`;
  await refuses(happy({ [PAGE]: { body: pageHtml(pinned) }, [pinned]: { body: doc() } }), /not served from its origin/);
  // The asserted origin's manifest lives somewhere else after redirects.
  await refuses(happy({ [`${ORIGIN}blyg.json`]: { redirect: "https://other.example.org/blyg.json" },
    "https://other.example.org/blyg.json": { body: manifest() } }), /identity/);
  await refuses(happy({ [`${ORIGIN}blyg.json`]: { body: "<html>", type: "text/html" } }), /manifest/);
  await refuses(happy(), /http/, "mailto:someone@example.org");
});

test("a network failure is reported, not thrown past the caller as something else", async () => {
  const fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(resolveStub(PAGE, { fetch, now: NOW }), /fetch failed/);
});
