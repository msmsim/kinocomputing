// The site's own furniture, on every page the build writes: the icons at the
// addresses browsers and readers look for them, and the site footer. Checked
// on a history that produces every kind of page — the stream, live notes, a
// frozen version and a tombstone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSite } from "./twin.mjs";

// The footer's parts, in order, as the PI asked for them.
const PARTS = [
  '<a class="home" href="/" target="_self">MARKKinocomputing</a>',
  "Automated independent research into alternative paradigms of computing and intelligence",
  'Orchestrated by <a href="https://www.msweet.net/">Matthew McDowell-Sweet</a>',
  "Reachable via matt@thisdomain",
];
// The masthead's mark, which the footer repeats ahead of the name.
const MARK = readFileSync(new URL("../notes/_stream.html", import.meta.url), "utf8").match(/<svg class="mark"[\s\S]*?<\/svg>/)[0];

function everyKindOfPage() {
  const site = makeSite();
  const t = (m) => `2026-11-01T10:${String(m).padStart(2, "0")}:00Z`;
  site.publish("001-ash-eels", { body: "<p><strong>A title</strong></p>\n<p>Body.</p>", iso: t(1), pin: true });
  site.publish("002-teal-larks", { body: "<p>Untitled.</p>", iso: t(2) });
  site.action(t(3));
  site.remove("002-teal-larks");
  site.action(t(4));
  return { site, tree: site.deploy() };
}

test("every page carries the site footer once: mark and name home | what it is | who | how to reach them", () => {
  const { site, tree } = everyKindOfPage();
  try {
    const pages = [...tree.keys()].filter((p) => p.endsWith(".html"));
    for (const kind of ["index.html", "a-title.html", "a-title-v1.html", "002-teal-larks.html"]) {
      assert.ok(pages.includes(kind), `no ${kind} to check`);
    }
    for (const path of pages) {
      const html = tree.get(path);
      const feet = html.match(/<footer class="sitefoot">[\s\S]*?<\/footer>/g) ?? [];
      assert.equal(feet.length, 1, `${path}: ${feet.length} site footers`);
      const [foot] = feet;
      const parts = [...foot.matchAll(/<span class="part">([\s\S]*?)<\/span>(?=<span class="sep"|<\/p>)/g)].map((m) => m[1]);
      assert.deepEqual(parts, PARTS.map((p) => p.replace("MARK", MARK)), `${path}: footer parts`);
      assert.equal((foot.match(/<span class="sep" aria-hidden="true"> \| <\/span>/g) ?? []).length, 3, `${path}: three bars between four parts`);
      // The mark at the head: every page but the stream, centred, home.
      const heads = html.match(/<header class="notehead">[\s\S]*?<\/header>/g) ?? [];
      assert.equal(heads.length, path === "index.html" ? 0 : 1, `${path}: ${heads.length} note heads`);
      if (heads.length) {
        assert.equal(heads[0], `<header class="notehead"><a href="/" target="_self" rel="home" aria-label="Kinocomputing: home">${MARK}</a></header>`, `${path}: note head`);
        assert.match(html, /<body[^>]*>\n<header class="notehead">/, `${path}: note head isn't first in the body`);
      }
      // After the page's own content and footer, before the counter script.
      assert.ok(html.indexOf(foot) > html.indexOf("</main>") || !html.includes("</main>"), `${path}: footer inside or before <main>`);
      const script = html.indexOf("data-goatcounter");
      if (script !== -1) assert.ok(html.indexOf(foot) < script, `${path}: footer after the counter script`);
    }
  } finally {
    site.dispose();
  }
});

test("icons: .ico and touch icon at the conventional addresses, all three linked from every page", () => {
  const { site, tree } = everyKindOfPage();
  try {
    for (const file of ["favicon.ico", "apple-touch-icon.png", "favicon.svg"]) {
      assert.ok(existsSync(join(site.root, "dist", file)), `dist/${file} missing`);
    }
    for (const path of [...tree.keys()].filter((p) => p.endsWith(".html"))) {
      const head = tree.get(path).split("</head>")[0];
      assert.match(head, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/, `${path}: no .ico link`);
      assert.match(head, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg\?v=[0-9a-f]{8}">/, `${path}: no svg link`);
      assert.match(head, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/, `${path}: no touch icon link`);
      assert.equal((head.match(/rel="icon"/g) ?? []).length, 2, `${path}: icon links duplicated`);
      // The browser's own bars take the page colour, not white.
      assert.equal((head.match(/<meta name="theme-color" content="#cbdff7">/g) ?? []).length, 1, `${path}: no single theme-color`);
    }
  } finally {
    site.dispose();
  }
});

test("a title's apostrophes close up in its address, however they are written", () => {
  const site = makeSite();
  try {
    const t = (m) => `2026-11-01T10:${String(m).padStart(2, "0")}:00Z`;
    site.publish("001-ash-eels", { body: "<p><strong>Don&#39;t panic</strong></p>\n<p>Body.</p>", iso: t(1) });
    site.publish("002-teal-larks", { body: "<p><strong>Didn’t stop</strong></p>\n<p>Body.</p>", iso: t(2) });
    site.publish("003-red-owls", { body: "<p><strong>It&apos;s rock &amp; roll</strong></p>\n<p>Body.</p>", iso: t(3) });
    site.action(t(4));
    const tree = site.deploy();
    for (const page of ["dont-panic", "didnt-stop", "its-rock-roll"]) {
      assert.ok(tree.has(`${page}.html`), `no ${page}.html among ${[...tree.keys()].filter((p) => p.endsWith(".html")).join(", ")}`);
    }
  } finally {
    site.dispose();
  }
});

test("the page colour reaches past the page's ends: html is painted, and the theme colour matches", () => {
  const css = readFileSync(new URL("../note.css", import.meta.url), "utf8");
  const colour = (sel) => css.match(new RegExp(`^${sel} \\{[^}]*?background: (#[0-9a-f]{6})`, "m"))?.[1];
  assert.equal(colour("html"), "#cbdff7", "html has no background of its own, so the page's ends show white");
  assert.equal(colour("body"), colour("html"), "html and body disagree on the page colour");
});

test("a 404 page: Cloudflare serves it, with a 404 status, for any address the site doesn't have", () => {
  const site = makeSite();
  try {
    // A note can't take the name, even by its title.
    site.publish("003-rust-crabs", { body: "<p><strong>404</strong></p>\n<p>A note about the number.</p>", iso: "2026-11-01T10:00:00Z" });
    site.action("2026-11-01T10:01:00Z");
    const tree = site.deploy();
    const page = tree.get("404.html");
    assert.ok(page, "no dist/404.html");
    assert.match(page, /<title>Not found \| Kinocomputing<\/title>/);
    assert.match(page, /<meta name="robots" content="noindex">/);
    assert.ok(!page.includes("article:published_time"), "404 page reads as a note");
    assert.ok(!page.includes('rel="canonical"'), "404 page claims a canonical address");
    assert.ok(page.includes('<a rel="home" href="/" target="_self">'), "404 page has no way home");
    assert.ok(tree.has("404-2.html") && tree.get("404-2.html").includes("A note about the number."),
      "the note titled 404 should be published beside it, at 404-2");
  } finally {
    site.dispose();
  }
});

test("links within the site open in place; links out open a new tab; the masthead's name links home", () => {
  const site = makeSite();
  try {
    const body = [
      "<p><strong>Links</strong></p>",
      '<p><a href="/about">rel</a> <a href="https://www.kinocomputing.com/x">www</a> <a href="https://kinocomputing.com/y?q=1">apex</a>',
      '<a href="https://example.org/">out</a> <a href="https://kinocomputing.com.evil.example/">lookalike</a> <a href="//cdn.example/x">protocol-relative</a>',
      '<a href="/z" target="_blank">asked for a tab</a></p>',
    ].join("\n");
    site.publish("001-ash-eels", { body, iso: "2026-11-01T10:01:00Z" });
    site.action("2026-11-01T10:02:00Z");
    const tree = site.deploy();
    for (const path of ["links.html", "index.html"]) {
      const html = tree.get(path);
      assert.ok(html, `no ${path}`);
      for (const href of ["/about", "https://www.kinocomputing.com/x", "https://kinocomputing.com/y?q=1"]) {
        assert.ok(html.includes(`<a href="${href}" target="_self">`), `${path}: ${href} should open in place`);
      }
      for (const href of ["https://example.org/", "https://kinocomputing.com.evil.example/", "//cdn.example/x"]) {
        assert.ok(html.includes(`<a href="${href}">`), `${path}: ${href} should open a new tab`);
      }
      assert.ok(html.includes('<a href="/z" target="_blank">'), `${path}: a link's own target stands`);
    }
    assert.match(tree.get("index.html"), /<h1 class="site-title"><a class="home" href="\/" target="_self" rel="home"><svg class="mark"[\s\S]*?<\/svg>Kinocomputing<\/a><\/h1>/);
  } finally {
    site.dispose();
  }
});
