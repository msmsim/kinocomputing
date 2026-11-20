// Generated publishing histories, run through the real pipeline (twin.mjs) and
// the reference model (model.mjs) side by side. After every deploy the
// deployed surface must be conformant (conformance.mjs) and say exactly what
// the model says. fast-check shrinks any failure to a short history.
//
//   ORACLE_RUNS=200 ORACLE_SEED=1 node --test test/oracle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { makeSite, json } from "./twin.mjs";
import { Model } from "./model.mjs";
import { conformance, feedEntries } from "./conformance.mjs";
import { FILES, bodyOf, opArbitrary, timeAt } from "./histories.mjs";

const RUNS = Number(process.env.ORACLE_RUNS ?? 25);
const SEED = process.env.ORACLE_SEED ? Number(process.env.ORACLE_SEED) : undefined;
const TOOLS = process.env.ORACLE_TOOLS || null; // a mutant's tools/, for the self-test

/** Runs one history; throws with the step that disagreed. */
export function runHistory(ops, { tools = TOOLS } = {}) {
  const site = makeSite({ tools });
  const model = new Model();
  const ctx = { ids: new Map(), served: new Set(), pins: new Map(), dirty: false };
  let minute = 0;
  try {
    for (const [step, o] of [...ops, { type: "action" }, { type: "deploy" }].entries()) {
      minute += 1;
      const now = timeAt(minute, false);
      const where = `step ${step} ${JSON.stringify(o)}`;
      if (o.type === "publish") {
        const { body, convertible } = bodyOf(o.file, o.variant);
        const prior = model.disk.get(o.file);
        const iso = o.keepTime && prior ? prior.iso : timeAt(minute, o.offset);
        const page = { body, convertible, iso, pin: o.pin, note: o.note, description: `d${minute}` };
        site.publish(o.file, page);
        model.publish(o.file, page);
        ctx.dirty = true;
      } else if (o.type === "rerender" || o.type === "pinThis") {
        const prior = model.disk.get(o.file);
        if (!prior) continue;
        const page = { ...prior, pin: o.type === "pinThis", note: null, description: `r${minute}` };
        site.publish(o.file, page);
        model.publish(o.file, page);
        ctx.dirty = true;
      } else if (o.type === "remove" || o.type === "removeMany") {
        for (const f of o.type === "remove" ? [o.file] : FILES.slice(0, 4)) {
          site.remove(f);
          model.remove(f);
        }
        ctx.dirty = true;
      } else if (o.type === "action") {
        const expected = model.action(now);
        const { code, out } = site.action(now);
        assert.equal(code === 0, expected, `${where}: the Action ${expected ? "failed" : "should have refused"}\n${out}`);
        if (expected) ctx.dirty = false;
      } else if (o.type === "deploy") {
        checkDeploy(site.deploy(), model, ctx, where);
      }
    }
  } finally {
    site.dispose();
  }
}

function checkDeploy(tree, model, ctx, where) {
  const violations = conformance(tree);
  assert.deepEqual(violations, [], `${where}: not conformant`);

  // P2: everything ever served is still served.
  for (const path of ctx.served) assert.ok(tree.has(path), `${where}: ${path} was served and is gone (P2)`);

  const docs = [...tree.keys()].filter((p) => /^items\/[^/]+\.json$/.test(p) && p !== "items/index.json")
    .map((p) => json(tree, p));
  assert.equal(docs.length, model.items.size, `${where}: ${docs.length} item documents, model has ${model.items.size}`);
  const byPage = new Map(docs.map((doc) => [doc.page, doc]));

  const idOf = new Map();
  for (const [file, item] of model.items) {
    const doc = byPage.get(item.page);
    assert.ok(doc, `${where}: no item document with page ${item.page} for ${file}`);
    // P3: one id per file, forever.
    if (ctx.ids.has(file)) assert.equal(doc.id, ctx.ids.get(file), `${where}: ${file} changed id (P3)`);
    ctx.ids.set(file, doc.id);
    idOf.set(file, doc.id);

    assert.equal(doc.kind, item.withdrawn ? "withdrawn" : "fragment", `${where}: ${file} kind`);
    assert.deepEqual(
      doc.changelog.map((e) => ({ version: e.version, at: e.at, note: e.note, pinned: e.pinned ?? false })),
      item.changelog.map((e) => ({ version: e.version, at: e.at, note: e.note, pinned: e.pinned ?? false })),
      `${where}: ${file} changelog (P4, P7, P9, P11)`);

    // P8: pins exactly as the changelog says, bytes fixed from the first sight.
    for (const e of item.changelog.filter((x) => x.pinned)) {
      const path = `items/${doc.id}/v${e.version}.json`;
      assert.ok(tree.has(path), `${where}: ${path} missing (P8)`);
      if (ctx.pins.has(path)) assert.equal(tree.get(path), ctx.pins.get(path), `${where}: ${path} changed bytes (P8)`);
      ctx.pins.set(path, tree.get(path));
    }
  }
  const pinFiles = [...tree.keys()].filter((p) => /^items\/[^/]+\/v\d+\.json$/.test(p));
  assert.equal(pinFiles.length, [...model.items.values()].flatMap((i) => i.changelog.filter((e) => e.pinned)).length,
    `${where}: pin documents (P1)`);

  // P15: the feed, entry for entry.
  const entries = feedEntries(tree.get("feed.xml"));
  const expected = model.feed();
  assert.deepEqual(entries.map((e) => e.guid), expected.map((e) => `blyg:${idOf.get(e.file)}:v${e.version}`),
    `${where}: feed entries (P15)`);
  expected.forEach((e, i) => {
    if (e.note && !e.withdrawn) assert.ok(entries[i].title.startsWith(e.note.replace(/&/g, "&amp;").replace(/"/g, "&quot;")),
      `${where}: ${entries[i].guid} title ${entries[i].title} doesn't lead with its note (P15)`);
  });

  for (const path of tree.keys()) if (path.startsWith("items/")) ctx.served.add(path);

  // Pages follow the notes on disk, so they're only comparable once the Action has caught up.
  if (ctx.dirty) return;
  const redirects = tree.get("_redirects") ?? "";
  for (const [file, item] of model.items) {
    const id = idOf.get(file);
    const onDisk = model.disk.get(file);
    // A note that has stopped converting is served from what its body now says,
    // which the registry can't follow; its surface is what P6 covers.
    if (onDisk && !onDisk.convertible) continue;
    const page = tree.get(`${item.page}.html`);
    assert.ok(page, `${where}: ${item.page}.html missing (${item.withdrawn ? "P11 tombstone" : "page"})`);
    if (item.withdrawn) {
      assert.ok(!page.includes("article:published_time"), `${where}: tombstone ${item.page} reads as a note (P11)`);
    } else {
      assert.ok(page.includes(`href="/items/${id}.json"`), `${where}: ${item.page} has no JSON alternate (P16)`);
      assert.ok(page.includes('rel="blyg"'), `${where}: ${item.page} has no rel=blyg (P16)`);
    }
    assert.ok(!/name="blyg:(pin|note)"/.test(page), `${where}: ${item.page} still carries a request meta`);
    for (const e of item.changelog.filter((x) => x.pinned)) {
      const frozen = tree.get(`${item.page}-v${e.version}.html`);
      assert.ok(frozen, `${where}: frozen page ${item.page}-v${e.version} missing (P10)`);
      const pin = json(tree, `items/${id}/v${e.version}.json`);
      assert.ok(frozen.includes(pin.content_html), `${where}: frozen page ${item.page}-v${e.version} isn't its pin's content (P10)`);
      assert.ok(frozen.includes(`<link rel="canonical" href="https://kinocomputing.com/${item.page}">`), `${where}: frozen page canonical (P10)`);
    }
    for (const old of (model.pages.get(file) ?? []).slice(0, -1)) {
      if (old === item.page) continue;
      assert.ok(redirects.includes(`/${old} /${item.page} 301`), `${where}: no redirect /${old} → /${item.page} (P17)`);
    }
  }
  assert.ok(tree.get("index.html").includes('rel="blyg"'), `${where}: stream has no rel=blyg (P16)`);
}

test("generated histories agree with the model", () => {
  fc.assert(fc.property(fc.array(opArbitrary, { minLength: 1, maxLength: 24 }), (ops) => runHistory(ops)),
    { numRuns: RUNS, seed: SEED, endOnFailure: !!TOOLS });
});

test("a history with nothing in it still deploys a conformant, empty surface", () => {
  runHistory([]);
});
