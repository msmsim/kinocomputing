// Mathematics (spec 0.4 §5.2): written as TeX between dollars, published as
// MathML Core with the TeX kept as an annotation, so a page draws it with no
// script, stylesheet or font, and a reader that won't draw MathML can show
// the TeX instead.
//
// The dollars follow pandoc's tex_math_dollars, as the reference client
// does: `$$…$$` is displayed; `$…$` is inline when the opening dollar is
// followed by a non-space and the closing one follows a non-space and isn't
// followed by a digit — so "$5 and $10" stays prices. `\$` is a dollar.
// Code is left alone.

import temml from "./vendor/temml.mjs";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m, e) => ENTITIES[e]);

// Inline: $ then a non-space, then anything without a dollar or a newline,
// ending in a non-space, then $ not followed by a digit. Display: $$…$$.
const MATH = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?=[^\s$])((?:[^$\n\\]|\\.)*?[^\s\\])\$(?!\d)/g;

/**
 * One formula as MathML Core: temml's output with its classes and inline
 * styles taken out, which readers are told to strip (§14) and which nothing
 * here needs. Throws on TeX it can't read.
 */
export function mathml(tex, display = false) {
  const out = temml.renderToString(tex, { displayMode: display, annotate: true, throwOnError: true });
  return out
    .replace(/\s(?:class|style)="[^"]*"/g, "")
    .replace(/^<math>/, display ? '<math display="block">' : "<math>")
    .replace(/^<math display="block"(?: display="block")+/, '<math display="block"');
}

/** Formulas in one run of text, already HTML-escaped. */
export function mathsInText(text) {
  return text.replace(MATH, (whole, display, inline) => {
    const tex = decode((display ?? inline).trim());
    try {
      return mathml(tex, display != null);
    } catch {
      return whole; // TeX that won't read stays as the author typed it
    }
  }).replace(/\\\$/g, "$");
}

/**
 * Formulas in a note's HTML: in its text only, never inside code, a
 * preformatted block, a formula already made, a script or a style.
 */
export function withMaths(html) {
  const skip = [];
  return html.split(/(<[^>]+>)/).map((part) => {
    const tag = part.match(/^<(\/?)([a-z][a-z0-9]*)\b/i);
    if (tag) {
      const name = tag[2].toLowerCase();
      if (["code", "pre", "math", "script", "style"].includes(name)) {
        if (tag[1]) skip.pop();
        else if (!/\/>$/.test(part)) skip.push(name);
      }
      return part;
    }
    return skip.length || !part.includes("$") ? part : mathsInText(part);
  }).join("");
}
