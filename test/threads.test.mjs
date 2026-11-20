// Threads and quotes (P21, P22), through the real pipeline: twin.mjs publishes
// pages as motes and the lab do, runs the Action and deploys. Every deploy is
// checked against conformance.mjs, which now reads §10 too, and the
// scenarios below pin the choices the spec leaves to the publisher.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSite, json } from "./twin.mjs";
import { conformance } from "./conformance.mjs";

const CLAIM = "<p><strong>Reservoirs per joule</strong></p>\n<p>A simulated reservoir beat its digital baseline per joule, on one task.</p>";
const CLAIM_2 = "<p><strong>Reservoirs per joule</strong></p>\n<p>A simulated reservoir beat its digital baseline per joule, on two tasks.</p>";
const whole = (slug) => `<blockquote class="kino-quote" data-note="${slug}"></blockquote>`;
const part = (slug, ...lines) => `<blockquote class="kino-quote" data-note="${slug}">\n${lines.map((l) => `<p>${l}</p>`).join("\n")}\n</blockquote>`;
const thread = (...quotes) => `<p><strong>What the reservoir result means</strong></p>\n<p>An argument.</p>\n${quotes.join("\n<p>Between.</p>\n")}\n<p>The end.</p>`;

let minute = 0;
const tick = () => `2026-11-21T03:${String(minute++).padStart(2, "0")}:00Z`;

/** A site, and helpers that run the Action and deploy and check conformance every time. */
function world() {
  const site = makeSite({ tools: process.env.ORACLE_TOOLS || null });
  const kinds = new Map();
  const publish = (file, body, extra = {}) => site.publish(file, { body, iso: tick(), ...extra });
  const step = () => {
    const action = site.action(tick());
    assert.equal(action.code, 0, action.out);
    const tree = site.deploy();
    assert.deepEqual(conformance(tree), [], "conformant");
    // P21: an item's kind, once born, never changes (withdrawal aside).
    for (const [path, text] of tree) {
      const m = path.match(/^items\/([^/]+)\.json$/);
      if (!m || m[1] === "index") continue;
      const doc = JSON.parse(text);
      if (doc.kind === "withdrawn") continue;
      if (kinds.has(doc.id)) assert.equal(doc.kind, kinds.get(doc.id), `${doc.id} changed kind`);
      kinds.set(doc.id, doc.kind);
    }
    return { tree, log: action.out };
  };
  const doc = (tree, file) => json(tree, `items/${readRegistryItems(site)[file].id}.json`);
  return { site, publish, step, doc, dispose: () => site.dispose() };
}

const readRegistryItems = (site) => JSON.parse(readFileSync(join(site.root, "blyg/_registry.json"), "utf8")).items;

test("a thread quotes a fragment whole and in part, published in the same act (P22)", () => {
  const w = world();
  try {
    w.publish("101-claim", CLAIM);
    // Its file sorts before the fragment's: registration order is tested, not assumed.
    w.publish("100-analysis", thread(whole("101-claim"), part("101-claim", "beat its digital baseline per joule")), { kind: "thread" });
    const { tree } = w.step();
    const claim = w.doc(tree, "101-claim");
    const analysis = w.doc(tree, "100-analysis");
    assert.equal(claim.kind, "fragment");
    assert.ok(!("transclusions" in claim));
    assert.equal(analysis.kind, "thread");
    assert.deepEqual(analysis.transclusions, [
      { id: claim.id, version: 1 },
      { id: claim.id, version: 1, selector: { exact: "beat its digital baseline per joule" } },
    ]);
    assert.match(analysis.content_md, new RegExp(`^!\\[\\[${claim.id}\\]\\]$\\n\\nBetween\\.\\n\\n!\\[\\[${claim.id}\\]\\]\\n> beat its digital baseline per joule$`, "m"));
    assert.ok(analysis.content_html.includes(`<blockquote class="blyg-transclusion" data-blyg-id="${claim.id}" data-blyg-version="1">\n${claim.content_html}\n</blockquote>`));
    assert.ok(analysis.content_html.includes(`<blockquote class="blyg-transclusion blyg-partial" data-blyg-id="${claim.id}" data-blyg-version="1">\n<p>beat its digital baseline per joule</p>\n</blockquote>`));
    // Feed: the thread is the newest entry of the act (§7).
    const feed = tree.get("feed.xml");
    assert.ok(feed.indexOf(`blyg:${analysis.id}:v1`) < feed.indexOf(`blyg:${claim.id}:v1`), "thread first in the feed");
    // The page shows the snapshot, with a way back to what it quotes.
    const page = tree.get(`${analysis.page}.html`);
    assert.ok(page.includes('class="blyg-transclusion"'), "baked on the page");
    assert.ok(page.includes(`<p class="quoted-from"><a href="/${claim.page}">quoted</a></p>`));
    assert.ok(!page.includes("kino-quote"), "no placeholder ships");
  } finally {
    w.dispose();
  }
});

test("a quote is a snapshot: the source moving on leaves it, a new version of the thread takes the new one (§10.2, §10.4)", () => {
  const w = world();
  try {
    w.publish("101-claim", CLAIM, { pin: true });
    w.publish("102-analysis", thread(whole("101-claim")), { kind: "thread" });
    w.step();
    w.publish("101-claim", CLAIM_2);
    let { tree } = w.step();
    const claim = w.doc(tree, "101-claim");
    let analysis = w.doc(tree, "102-analysis");
    assert.equal(claim.version, 2);
    assert.equal(analysis.version, 1, "the thread didn't change");
    assert.deepEqual(analysis.transclusions, [{ id: claim.id, version: 1 }], "stale, not live (§10.4)");
    assert.ok(analysis.content_html.includes("on one task"), "still the v1 snapshot");
    assert.ok(tree.get(`${analysis.page}.html`).includes(`<a href="/${claim.page}-v1">v1</a>`), "a pinned version is linked by its frozen page");

    w.publish("102-analysis", thread(whole("101-claim")).replace("An argument.", "A revised argument."), { kind: "thread" });
    ({ tree } = w.step());
    analysis = w.doc(tree, "102-analysis");
    assert.equal(analysis.version, 2);
    assert.deepEqual(analysis.transclusions, [{ id: claim.id, version: 2 }], "republish re-resolves");
    assert.ok(analysis.content_html.includes("on two tasks"));

    // Withdrawal doesn't cascade (§10.4): the thread keeps its snapshot.
    w.site.remove("101-claim");
    ({ tree } = w.step());
    assert.equal(w.doc(tree, "101-claim").kind, "withdrawn");
    assert.ok(w.doc(tree, "102-analysis").content_html.includes("on two tasks"));
  } finally {
    w.dispose();
  }
});

test("what can't be quoted leaves the thread unpublished, and says why (P22)", () => {
  const w = world();
  try {
    w.publish("101-claim", CLAIM);
    w.publish("102-analysis", thread(whole("101-claim")), { kind: "thread" });
    w.step();
    w.publish("103-of-a-thread", thread(whole("102-analysis")), { kind: "thread" });
    w.publish("104-of-nothing", thread(whole("999-missing")), { kind: "thread" });
    w.publish("105-misquote", thread(part("101-claim", "beat everything, always")), { kind: "thread" });
    w.publish("106-fragment-quoting", thread(whole("101-claim")));
    w.publish("107-self", thread(whole("107-self")), { kind: "thread" });
    const { tree, log } = w.step();
    const items = readRegistryItems(w.site);
    for (const file of ["103-of-a-thread", "104-of-nothing", "105-misquote", "106-fragment-quoting", "107-self"]) {
      assert.ok(!items[file], `${file} registered`);
    }
    assert.match(log, /103-of-a-thread: quotes 102-analysis, a thread/);
    assert.match(log, /104-of-nothing: quotes 999-missing, which isn't published/);
    assert.match(log, /105-misquote: quotes 101-claim with a selection that isn't in it/);
    assert.match(log, /106-fragment-quoting: a fragment can't quote/);
    assert.match(log, /107-self: quotes 107-self/);
    // An unresolved quote still deploys as a page, showing a link, not a placeholder.
    const page = [...tree.entries()].find(([path, text]) => path.endsWith(".html") && text.includes("quote-pending"));
    assert.ok(page, "a pending quote is shown as a link");
  } finally {
    w.dispose();
  }
});

test("an item's kind is fixed at registration (P21)", () => {
  const w = world();
  try {
    w.publish("101-claim", CLAIM);
    w.publish("102-analysis", thread(), { kind: "thread" });
    w.step();
    w.publish("101-claim", CLAIM_2, { kind: "thread" });
    w.publish("102-analysis", "<p>Now short, and unmarked.</p>");
    let { tree, log } = w.step();
    assert.equal(w.doc(tree, "101-claim").kind, "fragment");
    assert.equal(w.doc(tree, "102-analysis").kind, "thread");
    assert.deepEqual(w.doc(tree, "102-analysis").transclusions, [], "a thread that quotes nothing is valid (§5.3)");
    assert.match(log, /101-claim stays a fragment/);
    w.site.remove("102-analysis");
    ({ tree } = w.step());
    assert.deepEqual(w.doc(tree, "102-analysis").transclusions, [], "the endcap keeps an empty array (§9)");
    w.publish("102-analysis", "<p>Back.</p>");
    ({ tree } = w.step());
    assert.equal(w.doc(tree, "102-analysis").kind, "thread", "returning restores the original kind (§5.3)");
  } finally {
    w.dispose();
  }
});

test("a machine-written thread quoting a machine-written fragment carries both disclosures (P20, P22)", () => {
  const w = world();
  try {
    w.publish("101-claim", CLAIM, { generated: "claude-haiku-5-5", pin: true });
    w.publish("102-analysis", thread(whole("101-claim"), part("101-claim", "on one task.")), { kind: "thread", generated: "claude-sonnet-5-5", pin: true });
    const { tree } = w.step();
    const analysis = w.doc(tree, "102-analysis");
    assert.ok(analysis.content_html.startsWith('<div class="blyg-tk-gen">'));
    assert.equal((analysis.content_html.match(/class="blyg-tk-gen"/g) ?? []).length, 2, "its own, and the quoted fragment's inside the snapshot");
    const pin = json(tree, `items/${analysis.id}/v1.json`);
    assert.deepEqual(pin.transclusions, analysis.transclusions, "a pinned thread keeps its transclusions (§8)");
  } finally {
    w.dispose();
  }
});
