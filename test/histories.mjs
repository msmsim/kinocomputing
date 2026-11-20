// The publishing histories the oracles generate: motes events on a handful of
// notes, Action runs and deploys, in any order.

import fc from "fast-check";

export const FILES = ["001-ash-eels", "002-teal-larks", "003-rust-crabs", "004-sage-kites", "005-jade-owls"];

/** The body pool. Distinct strings convert to distinct markdown; variant 4 won't convert at all. */
export function bodyOf(file, variant) {
  switch (variant) {
    case 0: return { body: `<p>${file} first.</p>`, convertible: true };
    case 1: return { body: `<p>${file} second, <a href="/notes/${FILES[0]}">linked</a>, <a href="#more">below</a> and <a href="about">about</a> &amp; <em>so on</em>.</p>`, convertible: true };
    case 2: return { body: `<p><strong>Title ${file}</strong></p>\n<p>Titled.</p>`, convertible: true };
    case 3: return { body: `<p><strong>Other ${file}</strong></p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>`, convertible: true };
    default: return { body: `<table><tr><td>${file}</td></tr></table>`, convertible: false };
  }
}

const file = fc.constantFrom(...FILES);

export const opArbitrary = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    type: fc.constant("publish"), file, variant: fc.integer({ min: 0, max: 4 }),
    pin: fc.boolean(), note: fc.option(fc.constantFrom("fixed a typo", "said \"more\" & better"), { nil: null }),
    keepTime: fc.boolean(), offset: fc.boolean(),
  }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("rerender"), file }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("pinThis"), file }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("remove"), file }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("removeMany") }) },
  { weight: 4, arbitrary: fc.record({ type: fc.constant("action") }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("deploy") }) },
);

/** An ISO time `minutes` after the start, sometimes written with a +01:00 offset as motes does in summer. */
export function timeAt(minutes, offset) {
  const date = new Date(Date.UTC(2026, 10, 1, 10, 0, 0) + minutes * 60_000);
  if (!offset) return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const local = new Date(date.getTime() + 3_600_000).toISOString().slice(0, 19);
  return `${local}+01:00`;
}
