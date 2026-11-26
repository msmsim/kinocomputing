import { test } from "node:test";
import assert from "node:assert/strict";
import { glyph, glyphsFor } from "./glyph.mjs";

const note = (fileSlug, day) => ({ fileSlug, time: `2026-11-${String(day).padStart(2, "0")}T03:00:00Z` });

test("glyphsFor: no two notes share a glyph; a clash goes to the later note, which turns the handle until it has one of its own", () => {
  // A drawing that gives every name the same first glyph: every note after
  // the first has to turn.
  const draw = (name, turn = 0) => (turn === 0 ? "same" : `${name}:${turn}`);
  const glyphs = glyphsFor([note("c", 3), note("a", 1), note("b", 2)], draw);
  assert.equal(glyphs.get("a"), "same", "the oldest keeps the first drawing");
  assert.equal(glyphs.get("b"), "b:1");
  assert.equal(glyphs.get("c"), "c:1");
});

test("glyphsFor: adding a note never changes an earlier note's glyph", () => {
  const before = glyphsFor([note("a", 1), note("b", 2)]);
  const after = glyphsFor([note("a", 1), note("b", 2), note("c", 3)]);
  assert.equal(after.get("a"), before.get("a"));
  assert.equal(after.get("b"), before.get("b"));
});

test("glyphsFor: two thousand notes, two thousand glyphs", () => {
  const notes = Array.from({ length: 2000 }, (_, i) => ({ fileSlug: `lab-note-${i}`, time: new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString() }));
  assert.equal(new Set(glyphsFor(notes).values()).size, 2000);
  assert.notEqual(glyph("x"), glyph("x", 1), "a turn draws a different glyph");
});

test("glyph: ten cells in staggered rows of three, four and three — never a corner of the box — at most two of them empty", () => {
  const allowed = new Set(["10,5", "20,5", "30,5", "5,15", "15,15", "25,15", "35,15", "10,25", "20,25", "30,25"]);
  for (let i = 0; i < 300; i += 1) {
    const g = glyph(`note-${i}`);
    const centres = [
      ...[...g.matchAll(/<rect class="[os]" x="([\d.]+)" y="([\d.]+)" width="6"/g)].map((m) => `${Number(m[1]) + 3},${Number(m[2]) + 3}`),
      ...[...g.matchAll(/<path class="[os]" d="M([\d.]+) ([\d.]+)L/g)].map((m) => `${Number(m[1])},${Math.round((Number(m[2]) + 3.9) * 100) / 100}`),
    ];
    assert.ok(centres.length >= 8 && centres.length <= 10, `${centres.length} shapes`);
    for (const c of centres) assert.ok(allowed.has(c), `a shape centred at ${c}, outside the staggered rows`);
  }
});
