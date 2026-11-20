// The site's own furniture, on every page the build writes: the icons at the
// addresses browsers and readers look for them, and the site footer. Checked
// on a history that produces every kind of page — the stream, live notes, a
// frozen version and a tombstone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeSite } from "./twin.mjs";

const AUTHOR = '<a href="https://www.msweet.net/">Matthew McDowell-Sweet</a>';
const SUBTITLE = "Automated independent research into alternative paradigms of computing and intelligence.";

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

test("every page carries the site footer once: name home, subtitle, author", () => {
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
      assert.ok(foot.includes('<a href="/" target="_self">Kinocomputing</a>'), `${path}: footer doesn't name the site, linked home`);
      assert.ok(foot.includes(SUBTITLE), `${path}: footer has no subtitle`);
      assert.ok(foot.includes(AUTHOR), `${path}: footer has no author link`);
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
    }
  } finally {
    site.dispose();
  }
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
