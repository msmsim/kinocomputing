// Every note's glyph: a small drawing of its own, made from the site's mark
// (□◇, "always eventually"). Ten cells in three staggered rows — three, four,
// three, the outer rows set in by half a cell — so the whole has a soft,
// lozenge-like outline rather than a box's. Each cell is a square or a
// diamond, filled or in outline, or (now and then) nothing. No two notes
// share one, and a note keeps its own through every version.
//
// One colour, the ink: the drawing takes it from the page, so it follows the
// theme.

import { createHash } from "node:crypto";

const CELL = 10;
const SIZE = 6; // a square's side; a diamond fits the same box
const MOST_EMPTY = 2;
// Where each cell sits: rows of three, four and three, the short rows
// centred on the long one.
const CELLS = [[0.5, 0], [1.5, 0], [2.5, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0.5, 2], [1.5, 2], [2.5, 2]];

const n = (v) => Math.round(v * 100) / 100;

function shape(kind, solid, x, y) {
  const cls = solid ? "s" : "o";
  const cx = x + CELL / 2;
  const cy = y + CELL / 2;
  if (kind === "square") {
    const h = SIZE / 2;
    return `<rect class="${cls}" x="${n(cx - h)}" y="${n(cy - h)}" width="${SIZE}" height="${SIZE}"/>`;
  }
  const r = (SIZE / 2) * 1.3;
  return `<path class="${cls}" d="M${n(cx)} ${n(cy - r)}L${n(cx + r)} ${n(cy)}L${n(cx)} ${n(cy + r)}L${n(cx - r)} ${n(cy)}Z"/>`;
}

/**
 * A glyph as inline SVG, drawn from a name (a note's file name) and, when an
 * earlier note already has the first one, a turn of the handle.
 */
export function glyph(name, turn = 0) {
  const bytes = createHash("sha256").update(`kinocomputing-glyph:${name}${turn ? `:${turn}` : ""}`).digest();
  let empties = 0;
  const parts = [];
  for (const [i, [col, row]] of CELLS.entries()) {
    const b = bytes[i];
    if (b % 7 === 0 && empties < MOST_EMPTY) {
      empties += 1;
      continue;
    }
    parts.push(shape(b & 1 ? "square" : "diamond", Boolean(b & 2), col * CELL, row * CELL));
  }
  return `<svg class="glyph" viewBox="0 0 ${4 * CELL} ${3 * CELL}" aria-hidden="true">${parts.join("")}</svg>`;
}

/**
 * Every note's glyph, no two alike: notes oldest first, each taking the
 * first drawing from its name that no earlier note has. A note's glyph never
 * changes once it has one, since only later notes can meet it.
 */
export function glyphsFor(notes, draw = glyph) {
  const taken = new Set();
  const out = new Map();
  const order = [...notes].sort((a, b) => new Date(a.time) - new Date(b.time) || a.fileSlug.localeCompare(b.fileSlug));
  for (const note of order) {
    let turn = 0;
    let drawn = draw(note.fileSlug);
    while (taken.has(drawn)) drawn = draw(note.fileSlug, (turn += 1));
    taken.add(drawn);
    out.set(note.fileSlug, drawn);
  }
  return out;
}
