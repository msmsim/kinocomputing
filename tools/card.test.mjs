import { test } from "node:test";
import assert from "node:assert/strict";
import { cardKey, cardSvg, loadFonts, plainText, setTitle } from "./card.mjs";

const fonts = await loadFonts(new URL("..", import.meta.url).pathname);
const MEASURE = 1200 - 2 * 80;
const widthOf = (line, size) => fonts.serif[0].getAdvanceWidth(line, size, { kerning: true });

test("card: a title's HTML is the plain text drawn", () => {
  assert.equal(plainText("Why <em>this</em> &amp; that doesn&#39;t &#x2014; &rsquo;yet&rsquo;"), "Why this & that doesn't — ’yet’");
});

test("card: a title takes the largest size it fits, never runs past the measure, and a title too long is cut with an ellipsis", () => {
  const short = setTitle("A short title", fonts.serif);
  assert.deepEqual(short, { size: 68, lines: ["A short title"] });
  const long = "Physical reservoir computing reports tiny energy figures but its comparisons against digital baselines remain thin, unmatched, and mostly measured on toy tasks rather than real ones that anyone needs";
  const set = setTitle(long, fonts.serif);
  assert.ok(set.size < 68 && set.lines.length > 1);
  for (const line of set.lines) assert.ok(widthOf(line, set.size) <= MEASURE + 1, line);
  const endless = setTitle(Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "), fonts.serif);
  assert.equal(endless.size, 50);
  assert.ok(endless.lines.length <= 5);
  assert.match(endless.lines.at(-1), /…$/);
});

test("card: named by what it shows, so a new title or glyph is a new card; every letter an outline", () => {
  const shows = { title: "A title", date: "1 November 2026", glyph: '<svg class="glyph" viewBox="0 0 40 30" aria-hidden="true"><rect class="s" x="2" y="2" width="6" height="6"/><rect class="o" x="12" y="2" width="6" height="6"/></svg>' };
  assert.match(cardKey(shows), /^[0-9a-f]{16}$/);
  assert.notEqual(cardKey(shows), cardKey({ ...shows, title: "Another" }));
  assert.notEqual(cardKey(shows), cardKey({ ...shows, glyph: shows.glyph.replace('class="s"', 'class="o"') }));
  const svg = cardSvg(shows, fonts);
  assert.ok(!/<text\b/.test(svg), "no text for a rasteriser to need fonts for");
  assert.ok(!/class=/.test(svg), "the glyph's shapes are given their ink, with no stylesheet to give it");
  assert.match(svg, /width="1200" height="630"/);
});
