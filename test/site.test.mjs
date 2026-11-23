// The site's own furniture, on every page the build writes: the icons at the
// addresses browsers and readers look for them, and the site footer. Checked
// on a history that produces every kind of page — the stream, live notes, a
// frozen version and a tombstone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
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
        assert.ok(heads[0].startsWith(`<header class="notehead"><a href="/" target="_self" rel="home" aria-label="Kinocomputing: home">${MARK}</a>\n<nav class="sections" aria-label="Sections">`), `${path}: note head`);
        assert.deepEqual([...heads[0].matchAll(/<a href="([^"]+)" target="_self"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[1]} ${m[2]}`),
          ["/notes Notes", "/lab Lab", "/tracker Tracker", "/audits Audits", "/about About"], `${path}: section menu`);
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

test("agent readiness: structured data on every note and the stream, a sitemap, llms.txt, security.txt, robots.txt naming the sitemap", () => {
  const site = makeSite();
  const t = (m) => `2026-11-01T10:${String(m).padStart(2, "0")}:00Z`;
  try {
    site.publish("about", { body: "<p><strong>About</strong></p>\n<p>Independent research into alternative paradigms of computing and intelligence, and how it is done here.</p>", iso: t(1) });
    site.publish("001-ash-eels", { body: "<p><strong>A pinned note</strong></p>\n<p>Its opening paragraph, long enough to serve as a description on its own.</p>", iso: t(2), pin: true });
    site.publish("lab-2026-11-23-paradigm-gpus", { body: "<p><strong>GPUs: the leaderboard is public</strong></p>\n<p><em>By Concrete, one of the lab's AI voices</em></p>\n<p>Thousands of simple cores doing the same sum on big arrays, which is what neural networks need.</p>", iso: t(3), generated: "claude-sonnet-5-5" });
    site.publish("002-teal-larks", { body: "<p>Gone soon.</p>", iso: t(4) });
    site.action(t(5));
    site.remove("002-teal-larks");
    site.action(t(6));
    const tree = site.deploy();
    const ld = (path) => JSON.parse(tree.get(path).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);

    const home = ld("index.html")["@graph"];
    assert.deepEqual(home.map((n) => n["@type"]), ["WebSite", "ResearchProject", "Person", "Organization"]);
    assert.equal(home[1].founder["@id"], home[2]["@id"], "the project names its founder");

    const lab = ld("gpus-the-leaderboard-is-public.html")["@graph"][0];
    assert.equal(lab["@type"], "BlogPosting");
    assert.equal(lab.author["@id"], "https://www.kinocomputing.com/#lab", "a lab note is the lab's");
    assert.match(lab.creditText, /claude-sonnet-5-5/);
    assert.equal(lab.description.startsWith("Thousands of simple cores"), true, "the byline is no part of the description");
    const pinned = ld("a-pinned-note.html")["@graph"][0];
    assert.equal(pinned.author["@id"], "https://www.kinocomputing.com/#author", "the PI's note is the PI's");
    assert.equal(pinned.datePublished, t(2), "first published when its first version was");
    assert.equal(pinned.version, "1");
    assert.equal(ld("about.html")["@graph"][0]["@type"], "AboutPage");

    const sitemap = tree.get("sitemap.xml");
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, ["https://www.kinocomputing.com/",
      ...["notes", "lab", "tracker", "audits", "briefs"].map((id) => `https://www.kinocomputing.com/${id}`),
      "https://www.kinocomputing.com/a-pinned-note", "https://www.kinocomputing.com/about", "https://www.kinocomputing.com/gpus-the-leaderboard-is-public"],
      "the stream and live notes; not a withdrawn note, not a frozen version");

    const llms = tree.get("llms.txt");
    assert.match(llms, /^# Kinocomputing\n\n> /);
    assert.match(llms, /## Start here\n\n- \[About\]\(https:\/\/www\.kinocomputing\.com\/about\): Independent research/);
    assert.match(llms, /## The paradigm tracker's entries\n\n- \[GPUs: the leaderboard is public\]\(https:\/\/www\.kinocomputing\.com\/gpus-the-leaderboard-is-public\): Thousands/);
    assert.match(llms, /\[Sitemap\]\(https:\/\/www\.kinocomputing\.com\/sitemap\.xml\)/);

    const security = tree.get(".well-known/security.txt");
    assert.match(security, /^Contact: https:\/\/www\.kinocomputing\.com\/about$/m);
    const expires = new Date(security.match(/^Expires: (.+)$/m)[1]);
    const days = (expires - Date.now()) / 86400000;
    assert.ok(days > 270 && days < 366, `Expires ${days.toFixed(0)} days out: within a year, as RFC 9116 asks`);
    const robots = tree.get("robots.txt");
    assert.match(robots, /^Sitemap: https:\/\/www\.kinocomputing\.com\/sitemap\.xml$/m);
    assert.match(robots, /^User-agent: \*\nContent-Signal: search=yes,ai-input=yes,ai-train=yes\nAllow: \/$/m);
    for (const bot of ["GPTBot", "ClaudeBot", "Google-Extended", "OAI-SearchBot"]) assert.ok(!robots.includes(`User-agent: ${bot}`), `${bot} is welcome`);
    assert.match(robots, /^User-agent: Bytespider\n(?:User-agent: [^\n]+\n)*Disallow: \/$/m, "scrapers are refused");
  } finally {
    site.dispose();
  }
});

test("search snippets: a title that won't fit drops the site's name; a description that is just the title, or too short, is derived from the opening", () => {
  const site = makeSite();
  try {
    const long = "A title long enough that with the site name it runs past the cut";
    site.publish("001-ash-eels", { body: `<p><strong>${long}</strong></p>\n<p>Short opener.</p>\n<p>And then the paragraph that actually says what the note is about.</p>`, iso: "2026-11-01T10:01:00Z", description: long });
    site.publish("002-teal-larks", { body: "<p><strong>Short</strong></p>\n<p>Body.</p>", iso: "2026-11-01T10:02:00Z" });
    site.publish("003-red-owls", { body: "<p><strong>Kept</strong></p>\n<p>Body.</p>", iso: "2026-11-01T10:03:00Z", description: "An authored description that is just the right length for a search result." });
    site.action("2026-11-01T10:04:00Z");
    const tree = site.deploy();
    const head = (path, re) => tree.get(path).match(re)?.[1];
    const slug = "a-title-long-enough-that-with-the-site-name-it-runs-past-the";
    const page = [...tree.keys()].find((p) => p.startsWith(slug));
    assert.equal(head(page, /<title>([^<]*)<\/title>/), long, "the title alone, not cut off");
    assert.equal(head("short.html", /<title>([^<]*)<\/title>/), "Short | Kinocomputing");
    assert.equal(head(page, /<meta name="description" content="([^"]*)">/), "Short opener. And then the paragraph that actually says what the note is about.");
    assert.equal(head(page, /<meta property="og:description" content="([^"]*)">/), "Short opener. And then the paragraph that actually says what the note is about.");
    assert.equal(head("kept.html", /<meta name="description" content="([^"]*)">/), "An authored description that is just the right length for a search result.", "a usable authored one stands");
  } finally {
    site.dispose();
  }
});

test("sections: each a page and a plain feed, declared as hoppers; notes placed by what they say or who wrote them; the tracker a table of every paradigm", () => {
  const site = makeSite();
  const t = (m) => `2026-11-01T10:${String(m).padStart(2, "0")}:00Z`;
  try {
    site.publish("001-ash-eels", { body: "<p><strong>An essay of mine</strong></p>\n<p>What the essay argues, at enough length to describe it.</p>", iso: t(1) });
    site.publish("lab-2026-11-23-paradigm-gpus", { body: "<p><strong>GPUs: the leaderboard is public</strong></p>\n<p>Thousands of simple cores doing the same sum on big arrays, which is what neural networks need.</p>", iso: t(2), generated: "m" });
    site.publish("lab-2026-11-23-brief", { body: "<p><strong>Lab brief: 23 November 2026</strong></p>\n<p>What the shift did tonight, and what it cost.</p>", iso: t(3), generated: "m" });
    site.publish("lab-2026-11-23-memory-wall", { body: "<p><strong>A memory-wall test</strong></p>\n<p>A random read from memory is slow; we measured how slow.</p>", iso: t(4), generated: "m" });
    site.publish("lab-2026-11-23-twenty-watts", { body: "<p><strong>Does the brain run on twenty watts?</strong></p>\n<p>The figure everyone quotes, traced to where it came from.</p>", iso: t(5), generated: "m" });
    // The lab's publisher says where a note goes; an audit asks for audits.
    const p = join(site.root, "notes", "lab-2026-11-23-twenty-watts.html");
    writeFileSync(p, readFileSync(p, "utf8").replace("</head>", '    <meta name="kino:section" content="audits">\n</head>'));
    writeFileSync(join(site.root, "notes", "_tracker.json"), JSON.stringify({ updated: "2026-11-23", groups: [
      { name: "The incumbent stack", paradigms: [
        { id: "gpus", name: "GPUs and massively parallel acceleration", last_checked: "2026-11-23", entry: "lab-2026-11-23-paradigm-gpus" },
        { id: "symbolic-ai", name: "Symbolic AI", last_checked: null, entry: null },
      ] },
    ] }));
    site.action(t(6));
    const tree = site.deploy();
    const items = (id) => [...tree.get(`${id}.html`).matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(items("notes"), ["/an-essay-of-mine"]);
    assert.deepEqual(items("lab"), ["/a-memory-wall-test"]);
    assert.deepEqual(items("audits"), ["/does-the-brain-run-on-twenty-watts"]);
    assert.deepEqual(items("briefs"), ["/lab-brief-23-november-2026"]);
    assert.match(tree.get("lab.html"), /<nav class="sections"[^>]*>[\s\S]*?<a href="\/lab" target="_self" aria-current="page">Lab<\/a>/, "the menu marks where you are");
    assert.match(tree.get("a-memory-wall-test.html"), /<a href="\/lab" target="_self" aria-current="page">Lab<\/a>/, "and a note's page marks its section");
    assert.ok(!/aria-current/.test(tree.get("index.html").match(/<nav class="sections"[\s\S]*?<\/nav>/)[0]), "the stream has the menu, nothing marked");

    const tracker = tree.get("tracker.html");
    assert.match(tracker, /<body class="wide">/);
    assert.ok(!tracker.includes("<p></p>"), "no empty paragraph when there's nothing to say");
    assert.match(tracker, /<h2>The incumbent stack<\/h2>/);
    assert.match(tracker, /<tr><th scope="row"><a href="\/gpus-the-leaderboard-is-public" target="_self">GPUs and massively parallel acceleration<\/a><\/th><td>Thousands of simple cores[^<]*<\/td><td class="when"><time datetime="2026-11-23">23 Nov 2026<\/time><\/td><\/tr>/);
    assert.match(tracker, /<tr><th scope="row">Symbolic AI<\/th><td><span class="pending">Not yet looked at\.<\/span><\/td><td class="when">—<\/td><\/tr>/);
    const ld = JSON.parse(tracker.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"][0];
    assert.equal(ld["@type"], "CollectionPage");
    assert.deepEqual(ld.mainEntity.itemListElement.map((i) => i.url), ["https://www.kinocomputing.com/gpus-the-leaderboard-is-public"]);

    const feed = tree.get("feeds/lab.xml");
    assert.match(feed, /<title>Kinocomputing: Lab<\/title>/);
    assert.match(feed, /<link>https:\/\/www\.kinocomputing\.com\/a-memory-wall-test<\/link>/);
    assert.ok(!/xmlns:blyg/.test(feed), "a hopper's feed is plain RSS (spec 0.4 §13.5)");
    assert.match(tree.get("lab.html"), /<link rel="alternate" type="application\/rss\+xml" title="Kinocomputing: Lab" href="\/feeds\/lab\.xml">/);

    const manifest = JSON.parse(tree.get("blyg.json"));
    assert.deepEqual(manifest.hoppers.map((h) => [h.title, h.page, h.feed]), [
      ["Notes", "notes", "feeds/notes.xml"], ["Lab", "lab", "feeds/lab.xml"], ["Tracker", "tracker", "feeds/tracker.xml"],
      ["Audits", "audits", "feeds/audits.xml"], ["Briefs", "briefs", "feeds/briefs.xml"],
    ]);
    for (const item of [...tree.keys()].filter((k) => /^items\/[^/]+\.json$/.test(k) && k !== "items/index.json")) {
      assert.ok(!/hopper|section/.test(tree.get(item)), `${item}: no item names a hopper`);
    }
    assert.match(tree.get("llms.txt"), /## Sections\n\n- \[Notes\]\(https:\/\/www\.kinocomputing\.com\/notes\)/);
  } finally {
    site.dispose();
  }
});
