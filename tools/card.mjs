// Each note's share card: the picture a link to it shows wherever it's
// pasted. The note's title in the heading face, its date, its glyph
// (tools/glyph.mjs), and the site's mark and name, on the light page's
// colours, at the 1200×630 the scrapers want.
//
// The build can't draw a PNG with nothing installed, so the cards are drawn
// ahead of it and committed: `build-stream.mjs --cards` lists what every note's
// card shows in cards/_wanted.json, and this, run by the Action that records
// the blyg's state, draws any card not yet drawn and drops any no note wants.
// A card is named by a hash of what it shows, so a new title is a new card at
// a new address, and the scrapers' caches can't keep the old one.
//
// The text is drawn as outlines (opentype.js), so the rasteriser needs no
// fonts of its own and every machine draws the same card.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const CARD = { width: 1200, height: 630 };
// Bump to redraw every card after a change to how they're drawn.
const VERSION = 1;

const PAPER = "#cbdff7";
const INK = "#1a1a1a";
const GREY = "#555";
const MARGIN = 80;
const MEASURE = CARD.width - 2 * MARGIN;
// The title's sizes, largest first, with the lines each may take.
const SIZES = [[68, 3], [58, 4], [50, 5]];
const LEADING = 1.13;

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };

/** A title's HTML as the plain text a card draws: no tags, no entities. */
export const plainText = (html) => String(html)
  .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, "").replace(/<[^>]*>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (whole, name) => NAMED[name.toLowerCase()] ?? whole)
  .replace(/\s+/g, " ").trim();

/** A card's file name: a hash of everything it shows. */
export const cardKey = ({ title, date, glyph }) =>
  createHash("sha256").update(JSON.stringify({ v: VERSION, title, date, glyph })).digest("hex").slice(0, 16);

/**
 * Text as runs of the first face that has each character, so a title with a
 * symbol the heading face lacks still draws it rather than a box.
 */
function runs(text, faces) {
  const out = [];
  for (const ch of text) {
    const face = faces.find((f) => f.charToGlyphIndex(ch) > 0) ?? faces[0];
    if (out.at(-1)?.face === face) out.at(-1).text += ch;
    else out.push({ face, text: ch });
  }
  return out;
}

const width = (text, faces, size) =>
  runs(text, faces).reduce((sum, r) => sum + r.face.getAdvanceWidth(r.text, size, { kerning: true }), 0);

function draw(text, faces, size, x, y, fill) {
  let at = x;
  const paths = [];
  for (const r of runs(text, faces)) {
    paths.push(r.face.getPath(r.text, at, y, size, { kerning: true }).toPathData(2));
    at += r.face.getAdvanceWidth(r.text, size, { kerning: true });
  }
  return `<path fill="${fill}" d="${paths.join(" ")}"/>`;
}

/** Words into lines no wider than the measure; null when they need more than `most`. */
function wrap(text, faces, size, most) {
  const lines = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = lines.length ? `${lines.at(-1)} ${word}` : word;
    if (lines.length && width(next, faces, size) <= MEASURE) lines[lines.length - 1] = next;
    else lines.push(word);
  }
  return lines.length <= most && lines.every((l) => width(l, faces, size) <= MEASURE) ? lines : null;
}

/** The title at the largest size it fits, cut short with an ellipsis at the smallest if it never does. */
export function setTitle(title, faces) {
  for (const [size, most] of SIZES) {
    const lines = wrap(title, faces, size, most);
    if (lines) return { size, lines };
  }
  const [size, most] = SIZES.at(-1);
  const words = title.split(/\s+/).filter(Boolean);
  while (words.length > 1 && !wrap(`${words.join(" ")}…`, faces, size, most)) words.pop();
  return { size, lines: wrap(`${words.join(" ")}…`, faces, size, most) ?? [title.slice(0, 40)] };
}

/** The glyph's shapes, given the ink the page's stylesheet would give them. */
function glyphShapes(svg) {
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return inner
    .replaceAll('class="s"', `fill="${INK}"`)
    .replaceAll('class="o"', `fill="none" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"`);
}

/** The card as SVG, every letter an outline. */
export function cardSvg({ title, date, glyph }, fonts) {
  const { size, lines } = setTitle(title, fonts.serif);
  const lead = size * LEADING;
  // The title hangs from a line under the masthead.
  const top = 196 + size * 0.75;
  const titlePaths = lines.map((line, i) => draw(line, fonts.serif, size, MARGIN, top + i * lead, INK)).join("");
  const scale = 3.2; // the glyph, 40×30, at 128×96
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}">`
    + `<rect width="${CARD.width}" height="${CARD.height}" fill="${PAPER}"/>`
    // The mark, □◇, as favicon.svg draws it.
    + `<g transform="translate(${MARGIN - 4} 66) scale(1.6)" fill="none" stroke="${INK}" stroke-width="2.2">`
    + `<rect x="3.6" y="11.4" width="9.2" height="9.2"/><path d="M22.6 10.2 L28.4 16 L22.6 21.8 L16.8 16 Z" stroke-linejoin="round"/></g>`
    + draw("Kinocomputing", fonts.serifBold, 36, MARGIN + 64, 105, INK)
    + titlePaths
    + (date ? draw(date, fonts.sans, 26, MARGIN, CARD.height - 76, GREY) : "")
    + `<g transform="translate(${CARD.width - MARGIN - 40 * scale} ${CARD.height - 70 - 30 * scale}) scale(${scale})">${glyphShapes(glyph)}</g>`
    + "</svg>";
}

/** The faces, from the fontsource packages: the heading face first, a sans to fall back on. */
export async function loadFonts(root = process.cwd()) {
  const { default: opentype } = await import("opentype.js");
  const face = (pkg, file) => {
    const bytes = readFileSync(join(root, "node_modules/@fontsource", pkg, "files", file));
    return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const sans = [face("inter", "inter-latin-400-normal.woff"), face("inter", "inter-latin-ext-400-normal.woff"),
    face("inter", "inter-greek-400-normal.woff")];
  return {
    serif: [face("newsreader", "newsreader-latin-500-normal.woff"), face("newsreader", "newsreader-latin-ext-500-normal.woff"), ...sans],
    serifBold: [face("newsreader", "newsreader-latin-600-normal.woff")],
    sans,
  };
}

/** Draws the cards wanted and not yet drawn, and drops the ones no note wants. */
export async function drawCards(dir = "cards", root = process.cwd()) {
  const wanted = JSON.parse(readFileSync(join(dir, "_wanted.json"), "utf8"));
  const keep = new Set(wanted.map((w) => `${w.key}.png`));
  const missing = wanted.filter((w) => !existsSync(join(dir, `${w.key}.png`)));
  if (missing.length) {
    const fonts = await loadFonts(root);
    const { Resvg } = await import("@resvg/resvg-js");
    mkdirSync(dir, { recursive: true });
    for (const w of missing) {
      const png = new Resvg(cardSvg(w, fonts), { font: { loadSystemFonts: false } }).render().asPng();
      writeFileSync(join(dir, `${w.key}.png`), png);
    }
  }
  const dropped = readdirSync(dir).filter((f) => f.endsWith(".png") && !keep.has(f));
  for (const f of dropped) rmSync(join(dir, f));
  return { drawn: missing.length, dropped: dropped.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { drawn, dropped } = await drawCards(join(root, "cards"), root);
  console.log(`cards: drew ${drawn}, dropped ${dropped}`);
}
