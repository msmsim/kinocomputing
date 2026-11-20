// node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMentions, discoverEndpoint } from "./mentions.mjs";

const OURS = "https://www.example.com/notes/";
const THEIRS = "https://blyg.example.org/";
const TID = "6cjkc91fsp0pqaw37gzacxksgk";
const OID = "4mh0bfh8nsqvx1pxvdy6v3mts8";
const TARGET = `${THEIRS}t/${TID}/`;
const SOURCE = `${OURS}a`;
const OUR_DOC = `${OURS}items/${OID}.json`;
const ENDPOINT = `${THEIRS}webmention`;
const NOW = new Date("2026-10-18T12:00:00Z");

const STUB_OF = { origin: THEIRS, id: TID, version: 2, cited: { url: TARGET, retrieved: "2026-10-18T11:00:00Z" } };
const registry = (entry = {}) => ({ items: { a: { id: OID, stub_of: STUB_OF, changelog: [{ version: 1 }], ...entry } } });

const ourPage = `<html><head><link rel="alternate" type="application/json" href="/notes/items/${OID}.json"></head></html>`;
const ourDoc = (overrides = {}) => ({ blyg: "0.3", id: OID, origin: OURS, version: 1, kind: "thread", stub_of: STUB_OF, ...overrides });

/** A fetch over a table of GETs, recording every POST and answering it with `post`. */
function network(table, post = { status: 202 }) {
  const posts = [];
  const fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      posts.push({ url, body: String(init.body) });
      if (post.throws) throw new TypeError("fetch failed");
      return { ok: post.status < 300, status: post.status, url, headers: new Map(), text: async () => "" };
    }
    const entry = table[url];
    if (!entry) return { ok: false, status: 404, url, headers: new Map(), text: async () => "" };
    const body = typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
    return { ok: true, status: 200, url, headers: new Map([["content-type", typeof entry.body === "string" ? "text/html" : "application/json"], ["link", entry.link ?? ""]]), text: async () => body };
  };
  return { fetch, posts };
}

const live = (overrides = {}) => ({
  [SOURCE]: { body: ourPage },
  [OUR_DOC]: { body: ourDoc() },
  [`${THEIRS}blyg.json`]: { body: { blyg: "0.4", webmention: "webmention" } },
  ...overrides,
});

const run = (reg, state, fetch, options = {}) =>
  sendMentions({ registry: reg, state, origin: OURS, now: NOW, fetch, log: () => {}, ...options });

test("a live stub sends one W3C mention from its page to the target's page", async () => {
  const { fetch, posts } = network(live());
  const { state, changed } = await run(registry(), {}, fetch);
  assert.deepEqual(posts, [{ url: ENDPOINT, body: new URLSearchParams({ source: SOURCE, target: TARGET }).toString() }]);
  assert.equal(changed, true);
  assert.deepEqual(state.a, { phase: "stub", source: SOURCE, target: TARGET, version: 2, endpoint: ENDPOINT,
    status: "sent", code: 202, attempts: 1, at: "2026-10-18T12:00:00Z" });

  // Sent is sent: the next run does nothing.
  const again = await run(registry(), state, fetch);
  assert.equal(posts.length, 1);
  assert.equal(again.changed, false);
});

test("nothing is sent until the deployed document carries the stub", async () => {
  const { fetch, posts } = network(live({ [OUR_DOC]: { body: ourDoc({ kind: "fragment", stub_of: undefined }) } }));
  const { state } = await run(registry(), {}, fetch);
  assert.equal(posts.length, 0);
  assert.equal(state.a.status, "pending");
  assert.equal(state.a.attempts, 0);
});

test("same-origin stubs and plain fragments never mention", async () => {
  const { fetch, posts } = network(live());
  const own = { items: { a: { id: OID, stub_of: { ...STUB_OF, origin: OURS }, changelog: [{ version: 1 }] }, b: { id: "x", changelog: [] } } };
  const { changed } = await run(own, {}, fetch);
  assert.equal(posts.length, 0);
  assert.equal(changed, false);
});

test("5xx, 429 and network failures retry on the backoff, then give up; other 4xx stop at once", async () => {
  let { fetch } = network(live(), { status: 503 });
  let { state } = await run(registry(), {}, fetch);
  assert.equal(state.a.status, "retry");
  assert.equal(state.a.next_at, "2026-10-18T12:15:00Z");

  // Not due yet: untouched.
  const early = await run(registry(), state, fetch, { now: new Date("2026-10-18T12:10:00Z") });
  assert.equal(early.changed, false);

  // Due, and failing again: the next step of the backoff.
  ({ fetch } = network(live(), { throws: true }));
  ({ state } = await run(registry(), state, fetch, { now: new Date("2026-10-18T12:20:00Z") }));
  assert.equal(state.a.attempts, 2);
  assert.equal(state.a.next_at, "2026-10-18T13:20:00Z");

  // After the last step, abandoned.
  ({ fetch } = network(live(), { status: 429 }));
  for (let i = 0; i < 4; i += 1) {
    ({ state } = await run(registry(), state, fetch, { now: new Date(Date.parse("2026-10-20T00:00:00Z") + i * 2 * 86400e3) }));
  }
  assert.equal(state.a.attempts, 6);
  assert.equal(state.a.status, "abandoned");

  ({ fetch } = network(live(), { status: 400 }));
  ({ state } = await run(registry(), {}, fetch));
  assert.equal(state.a.status, "failed");
  assert.equal(state.a.code, 400);
});

test("a target with no endpoint is recorded unreachable and not retried", async () => {
  const { fetch, posts } = network(live({ [`${THEIRS}blyg.json`]: { body: { blyg: "0.4" } }, [TARGET]: { body: "<html></html>" } }));
  const { state } = await run(registry(), {}, fetch);
  assert.equal(state.a.status, "unreachable");
  assert.equal(posts.length, 0);
  assert.equal((await run(registry(), state, fetch)).changed, false);
});

test("endpoint discovery: manifest key, then Link header, then the page's own link", async () => {
  const manifestless = (target) => ({ [`${THEIRS}blyg.json`]: { body: { blyg: "0.4" } }, ...target });
  assert.equal(await discoverEndpoint(THEIRS, TARGET, network(live()).fetch), ENDPOINT);
  assert.equal(await discoverEndpoint(THEIRS, TARGET, network(manifestless({
    [TARGET]: { body: "<html></html>", link: '<https://wm.example.net/in>; rel="webmention"' } })).fetch),
  "https://wm.example.net/in");
  assert.equal(await discoverEndpoint(THEIRS, TARGET, network(manifestless({
    [TARGET]: { body: '<html><head><link rel="webmention" href="/wm"></head></html>' } })).fetch),
  "https://blyg.example.org/wm");
});

test("a withdrawn stub that was sent re-sends once, after its endcap is live", async () => {
  const sent = { a: { phase: "stub", source: SOURCE, target: TARGET, version: 2, endpoint: ENDPOINT, status: "sent", code: 202, attempts: 1, at: "x" } };
  const withdrawn = registry({ withdrawn: true });

  const notYet = network(live());
  const pending = await run(withdrawn, sent, notYet.fetch);
  assert.equal(notYet.posts.length, 0);
  assert.equal(pending.state.a.phase, "withdrawal");
  assert.equal(pending.state.a.status, "pending");

  const { fetch, posts } = network(live({ [OUR_DOC]: { body: ourDoc({ kind: "withdrawn", stub_of: undefined }) } }));
  const { state } = await run(withdrawn, pending.state, fetch);
  assert.equal(posts.length, 1);
  assert.equal(state.a.status, "sent");
  assert.equal((await run(withdrawn, state, fetch)).changed, false);

  // One never sent has nothing to take back.
  const never = network(live());
  assert.equal((await run(withdrawn, {}, never.fetch)).changed, false);
});

test("a dry run discovers and reports, and neither posts nor records", async () => {
  const { fetch, posts } = network(live());
  const lines = [];
  const { changed } = await run(registry(), {}, fetch, { dryRun: true, log: (line) => lines.push(line) });
  assert.equal(posts.length, 0);
  assert.equal(changed, false);
  assert.match(lines.join("\n"), /would send .*source=.*target=/);
});
