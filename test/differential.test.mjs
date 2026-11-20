// msn as an oracle: the same generated histories through msn's build (the
// implementation this one transfuses) and this one, compared on everything
// protocol-level the two should agree on — versions, changelog times and
// notes, pins, content, hashes, feed order. Pages, origins and chrome differ
// by design and aren't compared.
//
// msn's copy is patched in the twin only, to take its clock from BLYG_NOW.
// Skipped when ../msn isn't checked out beside this repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { makeSite, readTree, Site } from "./twin.mjs";
import { bodyOf, opArbitrary, timeAt, FILES } from "./histories.mjs";
import { feedEntries } from "./conformance.mjs";

const MSN = new URL("../../msn/", import.meta.url).pathname;
const RUNS = Number(process.env.ORACLE_RUNS ?? 25);

function makeMsn() {
  const root = mkdtempSync(join(tmpdir(), "msn-twin-"));
  cpSync(join(MSN, "tools"), join(root, "tools"), { recursive: true });
  mkdirSync(join(root, "notes"));
  for (const name of ["_note.html", "_stream.html"]) cpSync(join(MSN, "notes", name), join(root, "notes", name));
  const build = join(root, "tools/build-stream.mjs");
  const source = readFileSync(build, "utf8");
  const patched = source.replace("{ now: new Date(), present }", "{ now: new Date(process.env.BLYG_NOW ?? Date.now()), present }");
  assert.notEqual(patched, source, "msn's build no longer has the clock this patches");
  writeFileSync(build, patched);
  return new Site(root);
}

/** Both surfaces reduced to what they must agree on, keyed by source file. */
function facts(tree, pageToFile) {
  const docs = [...tree.keys()].filter((p) => /^items\/[^/]+\.json$/.test(p) && p !== "items/index.json")
    .map((p) => JSON.parse(tree.get(p)));
  const fileOf = new Map();
  const items = {};
  for (const doc of docs) {
    const file = pageToFile(doc);
    fileOf.set(doc.id, file);
    items[file] = {
      kind: doc.kind, version: doc.version, created: doc.created, updated: doc.updated,
      content_md: doc.content_md, content_hash: doc.content_hash,
      changelog: doc.changelog,
      pins: Object.fromEntries(doc.changelog.filter((e) => e.pinned).map((e) => {
        const pin = JSON.parse(tree.get(`items/${doc.id}/v${e.version}.json`));
        return [e.version, { content_md: pin.content_md, at: pin.at, note: pin.note }];
      })),
    };
  }
  const feed = feedEntries(tree.get("feed.xml")).map((e) => `${fileOf.get(e.id)}:v${e.version}:${e.title}`);
  return { items, feed };
}

function runBoth(ops) {
  const kino = makeSite();
  const msn = makeMsn();
  // kino's pages are named by title; its registry, not the page, knows the file.
  const kinoFile = () => {
    const registry = JSON.parse(readFileSync(join(kino.root, "blyg/_registry.json"), "utf8")).items;
    const byId = new Map(Object.entries(registry).map(([file, entry]) => [entry.id, file]));
    return (doc) => byId.get(doc.id);
  };
  const disk = new Map();
  let minute = 0;
  try {
    for (const [step, o] of [...ops, { type: "action" }].entries()) {
      minute += 1;
      const now = timeAt(minute, false);
      if (o.type === "publish") {
        const { body } = bodyOf(o.file, o.variant);
        const prior = disk.get(o.file);
        const page = { body, iso: o.keepTime && prior ? prior.iso : timeAt(minute, o.offset), pin: o.pin, note: o.note, description: `d${minute}` };
        disk.set(o.file, page);
        kino.publish(o.file, page);
        msn.publish(o.file, page);
      } else if (o.type === "rerender" || o.type === "pinThis") {
        const prior = disk.get(o.file);
        if (!prior) continue;
        const page = { ...prior, pin: o.type === "pinThis", note: null, description: `r${minute}` };
        disk.set(o.file, page);
        kino.publish(o.file, page);
        msn.publish(o.file, page);
      } else if (o.type === "remove" || o.type === "removeMany") {
        for (const f of o.type === "remove" ? [o.file] : FILES.slice(0, 4)) {
          disk.delete(f);
          kino.remove(f);
          msn.remove(f);
        }
      } else if (o.type === "action") {
        const k = kino.action(now);
        const m = msn.run([], { BLYG_NOW: now });
        assert.equal(k.code === 0, m.code === 0, `step ${step}: kino ${k.code}, msn ${m.code}\n${k.out}\n${m.out}`);
        if (k.code !== 0) continue;
        if (!existsSync(join(kino.root, "blyg/_registry.json"))) continue;
        const ours = facts(readTree(join(kino.root, "blyg")), kinoFile());
        const theirs = facts(readTree(join(msn.root, "notes")), (doc) => doc.page);
        assert.deepEqual(ours, theirs, `step ${step} ${JSON.stringify(o)}: kinocomputing and msn disagree`);
      }
    }
  } finally {
    kino.dispose();
    msn.dispose();
  }
}

test("kinocomputing's surface agrees with msn's on the same history", { skip: !existsSync(MSN) && "no ../msn" }, () => {
  fc.assert(fc.property(fc.array(opArbitrary, { minLength: 1, maxLength: 24 }), runBoth), { numRuns: RUNS });
});
