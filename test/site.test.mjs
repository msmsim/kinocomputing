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

const menuOf = (html) => html.match(/<nav class="sections"[\s\S]*?<\/nav>/)[0];

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
          ["/ Notes", "/tracker Tracker", "/reading Reading", "/about About"], `${path}: the menu`);
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
      "https://www.kinocomputing.com/tracker", "https://www.kinocomputing.com/reading",
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

test("one stream, one feed; the menu is Notes, Tracker, About; the tracker is a page of its own, a table of every paradigm; the retired views redirect", () => {
  const site = makeSite();
  const t = (m) => `2026-11-01T10:${String(m).padStart(2, "0")}:00Z`;
  try {
    site.publish("001-ash-eels", { body: "<p><strong>An essay of mine</strong></p>\n<p>What the essay argues, at enough length to describe it.</p>", iso: t(1) });
    site.publish("lab-2026-11-23-paradigm-gpus", { body: "<p><strong>GPUs: the leaderboard is public</strong></p>\n<p>Thousands of simple cores doing the same sum on big arrays, which is what neural networks need.</p>", iso: t(2), generated: "m" });
    site.publish("lab-2026-11-23-memory-wall", { body: "<p><strong>A memory-wall test</strong></p>\n<p>A random read from memory is slow; we measured how slow.</p>", iso: t(3), generated: "m" });
    writeFileSync(join(site.root, "notes", "_tracker.json"), JSON.stringify({ updated: "2026-11-23", groups: [
      { name: "The incumbent stack", paradigms: [
        { id: "gpus", name: "GPUs and massively parallel acceleration", last_checked: "2026-11-23", entry: "lab-2026-11-23-paradigm-gpus" },
        { id: "symbolic-ai", name: "Symbolic AI", last_checked: null, entry: null },
      ] },
    ] }));
    site.action(t(4));
    const tree = site.deploy();
    const menu = (path) => tree.get(path).match(/<nav class="sections"[\s\S]*?<\/nav>/)[0];
    assert.match(menu("index.html"), /<a href="\/" target="_self" aria-current="page">Notes<\/a>/, "the stream is Notes");
    assert.match(menu("a-memory-wall-test.html"), /<a href="\/" target="_self" aria-current="page">Notes<\/a>/, "a note is in Notes");
    assert.match(menu("gpus-the-leaderboard-is-public.html"), /<a href="\/tracker" target="_self" aria-current="page">Tracker<\/a>/, "an entry is in the Tracker");

    const tracker = tree.get("tracker.html");
    assert.match(tracker, /<body>/, "the notes' own column, no wide page");
    assert.match(tracker, /<h2>The incumbent stack<\/h2>/);
    assert.match(tracker, /<tr><th scope="row"><a href="\/gpus-the-leaderboard-is-public" target="_self">GPUs and massively parallel acceleration<\/a><\/th><td>Thousands of simple cores[^<]*<\/td><td class="when"><time datetime="2026-11-23">23 Nov 2026<\/time><\/td><\/tr>/);
    assert.match(tracker, /<tr><th scope="row">Symbolic AI<\/th><td><span class="pending">Not yet looked at\.<\/span><\/td><td class="when">—<\/td><\/tr>/);
    assert.ok(!tracker.includes("<p></p>"));
    const ld = JSON.parse(tracker.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"][0];
    assert.equal(ld["@type"], "CollectionPage");
    assert.deepEqual(ld.mainEntity.itemListElement.map((i) => i.url), ["https://www.kinocomputing.com/gpus-the-leaderboard-is-public"]);

    // One feed of notes: the site's own. No view of the notes has one; the
    // only other feed is the reading list's, the hopper, of other people's links.
    assert.deepEqual([...tree.keys()].filter((k) => k.endsWith(".xml") && k !== "sitemap.xml").sort(), ["feed.xml", "feeds/reading.xml"]);
    assert.ok(!/rel="alternate" type="application\/rss\+xml"[^>]*feeds\//.test(tracker));
    assert.deepEqual(JSON.parse(tree.get("blyg.json")).hoppers, [{ title: "Reading", page: "reading", feed: "feeds/reading.xml" }]);
    for (const gone of ["notes", "lab", "audits", "briefs"]) {
      assert.ok(!tree.has(`${gone}.html`), `no ${gone} page`);
      assert.match(tree.get("_redirects"), new RegExp(`^/${gone} / 301$`, "m"));
      assert.match(tree.get("_redirects"), new RegExp(`^/feeds/${gone}\\.xml /feed\\.xml 301$`, "m"));
    }
    assert.match(tree.get("llms.txt"), /## The tracker\n\n- \[Tracker\]\(https:\/\/www\.kinocomputing\.com\/tracker\)/);
  } finally {
    site.dispose();
  }
});

test("reading: the lab's list of links, newest first, filterable, with its feed as the manifest's hopper; a share's address lands on its row", () => {
  const site = makeSite();
  try {
    site.publish("lab-2026-11-25-photonic-note", { body: "<p><strong>A photonic note</strong></p>\n<p>It used the chip paper, and said so.</p>", iso: "2026-11-25T03:00:00Z", generated: "m" });
    writeFileSync(join(site.root, "notes", "_tracker.json"), JSON.stringify({ groups: [{ name: "Let physics compute", paradigms: [{ id: "photonic", name: "Photonic / optical computing" }] }] }));
    writeFileSync(join(site.root, "notes", "_hopper.json"), JSON.stringify({ updated: "2026-11-25", items: [
      { id: "500-amber-owls", url: "https://example.org/chip?a=1&b=2", title: "A new <photonic> chip", site: "example.org", added: "2026-11-25", from: "pi", paradigms: ["photonic"], why: "A measured 10 fJ per operation, on silicon.", used_in: ["lab-2026-11-25-photonic-note"] },
      { id: "r-0123456789", url: "https://arxiv.org/abs/2611.00001", title: "A reservoir paper", site: "arxiv.org", added: "2026-11-24", from: "lab", paradigms: [], why: "Found while checking the reservoir entry.", used_in: [] },
      { id: "bad id", url: "javascript:alert(1)", title: "x", added: "2026-11-24" },
    ] }));
    site.action("2026-11-25T04:00:00Z");
    const tree = site.deploy();
    const page = tree.get("reading.html");
    const rows = [...page.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(rows, ["500-amber-owls", "r-0123456789"], "newest first; a bad line never shows");
    assert.match(page, /<li id="500-amber-owls" data-paradigms="photonic" data-text="[^"]*photonic \/ optical computing"><a href="https:\/\/example\.org\/chip\?a=1&amp;b=2">A new &lt;photonic&gt; chip<\/a> <span class="site">example\.org<\/span> <time datetime="2026-11-25">25 Nov 2026<\/time><br><span class="summary">A measured 10 fJ per operation, on silicon\.<\/span><br><span class="meta"><span class="tag" data-paradigm="photonic">Photonic \/ optical computing<\/span> · Used in <a href="\/a-photonic-note" target="_self">A photonic note<\/a><\/span><\/li>/);
    assert.match(page, /<form id="reading-filter" class="filter" role="search" hidden/, "the filter shows only when its script runs");
    assert.match(page, /<option value="photonic">Photonic \/ optical computing<\/option>/);
    assert.match(page, /<\/main>\n<script>/);
    assert.match(menuOf(page), /<a href="\/reading" target="_self" aria-current="page">Reading<\/a>/);

    const feed = tree.get("feeds/reading.xml");
    assert.match(feed, /<item>\n      <title>A new &lt;photonic&gt; chip<\/title>\n      <link>https:\/\/example\.org\/chip\?a=1&amp;b=2<\/link>\n      <guid isPermaLink="false">https:\/\/www\.kinocomputing\.com\/reading#500-amber-owls<\/guid>/);
    assert.ok(!/xmlns:blyg/.test(feed), "a hopper's feed is plain RSS");
    assert.match(tree.get("_redirects"), /^\/reading\/:share \/reading#:share 302$/m, "the address the receiver gives Subset");
    assert.match(tree.get("llms.txt"), /## Reading\n\n- \[Reading\]\(https:\/\/www\.kinocomputing\.com\/reading\)/);
  } finally {
    site.dispose();
  }
});

test("reading, empty: the page says so and carries no filter", () => {
  const site = makeSite();
  try {
    site.publish("001-ash-eels", { body: "<p>A note.</p>", iso: "2026-11-25T03:00:00Z" });
    site.action("2026-11-25T04:00:00Z");
    const page = site.deploy().get("reading.html");
    assert.match(page, /Nothing yet: the first links arrive/);
    assert.ok(!page.includes("<script>\n(() =>"), "no script when there is nothing to filter");
  } finally {
    site.dispose();
  }
});

test("previews lead with the lead: a byline or a bold label above it is passed over in the stream and the description; the tracker shows where a paradigm stands in full", () => {
  const site = makeSite();
  const long = "Thousands of simple cores doing the same sum on big arrays, which is what neural networks need; MLPerf drew 95 systems on 13 kinds of accelerator in its June round, and none of them reported energy, which is the number that matters for anything that has to run on a budget of watts rather than of money.";
  try {
    site.publish("lab-2026-11-25-voiced", { body: "<p><strong>A voiced note</strong></p>\n<p><em>By Bompa, one of the lab's AI voices</em></p>\n<p>The lead, which says what the note found and why it matters.</p>\n<p>More.</p>", iso: "2026-11-25T03:00:00Z", generated: "m" });
    site.publish("lab-2026-11-25-brief", { body: "<p><strong>Lab brief: 25 November 2026</strong></p>\n<p><strong>First shift</strong></p>\n<p>Tonight the lab looked at three paradigms and published seven notes.</p>", iso: "2026-11-25T04:00:00Z", generated: "m" });
    site.publish("lab-2026-11-23-paradigm-gpus", { body: `<p><strong>GPUs: the leaderboard is public</strong></p>\n<p>The one-clause lead.</p>\n<p><strong>Where it stands.</strong> ${long} <a href="https://mlcommons.org/">MLPerf</a>.</p>\n<p><strong>What an outsider can use.</strong> Zeus.</p>`, iso: "2026-11-23T03:00:00Z", generated: "m" });
    writeFileSync(join(site.root, "notes", "_tracker.json"), JSON.stringify({ groups: [{ name: "The incumbent stack", paradigms: [{ id: "gpus", name: "GPUs", last_checked: "2026-11-23", entry: "lab-2026-11-23-paradigm-gpus" }] }] }));
    site.action("2026-11-25T05:00:00Z");
    const tree = site.deploy();
    const stream = tree.get("index.html");
    const preview = (title) => stream.split(`<h2 class="title">${title}</h2>`)[1].split("</article>")[0];
    assert.match(preview("A voiced note"), /^\n<p>The lead, which says what the note found and why it matters\.<\/p>\n<p class="more">/, "the byline is passed over");
    assert.match(preview("Lab brief: 25 November 2026"), /^\n<p>Tonight the lab looked at three paradigms/, "so is a bold label");
    assert.match(preview("Lab brief: 25 November 2026"), /Read more…/, "with a way in to what was passed over");
    assert.match(tree.get("a-voiced-note.html"), /<meta name="description" content="The lead, which says what the note found/);
    assert.match(tree.get("lab-brief-25-november-2026.html"), /<meta name="description" content="Tonight the lab looked at three paradigms/);
    const cell = tree.get("tracker.html").match(/<tr><th scope="row">[\s\S]*?<\/th><td>([\s\S]*?)<\/td>/)[1];
    assert.ok(cell.startsWith("Thousands of simple cores"), "the Where it stands paragraph, its label dropped");
    assert.ok(cell.includes("budget of watts rather than of money.") && cell.includes('<a href="https://mlcommons.org/">MLPerf</a>'), "in full, links and all");
    assert.ok(!cell.includes("…"), "never cut short");
  } finally {
    site.dispose();
  }
});

test("maths: $…$ and $$…$$ become MathML with the TeX kept; prices and code are left alone; the item keeps the TeX (spec 0.4 §5.2)", () => {
  const site = makeSite();
  try {
    const body = [
      "<p><strong>Euler and Basel</strong></p>",
      "<p>Euler's identity, $e^{i\\pi}+1=0$, costs nothing; the coffee cost $5 and $10.</p>",
      "<p>$$\\sum_{n=1}^\\infty \\frac{1}{n^2}=\\frac{\\pi^2}{6}$$</p>",
      "<p>In code it stays put: <code>$x$</code>, and \\$3 is a price.</p>",
    ].join("\n");
    site.publish("001-ash-eels", { body, iso: "2026-11-26T10:00:00Z" });
    site.action("2026-11-26T10:01:00Z");
    const tree = site.deploy();
    const page = tree.get("euler-and-basel.html");
    assert.match(page, /<math><semantics><mrow><msup><mi>e<\/mi>[\s\S]*?<annotation encoding="application\/x-tex">e\^\{i\\pi\}\+1=0<\/annotation><\/semantics><\/math>/);
    assert.match(page, /<p><math display="block"><semantics>[\s\S]*<annotation encoding="application\/x-tex">\\sum_\{n=1\}\^\\infty/);
    assert.ok(!/ class="tml|style="display/.test(page), "no classes or inline styles in the MathML");
    assert.match(page, /the coffee cost \$5 and \$10\./, "prices are prices");
    assert.match(page, /<code>\$x\$<\/code>, and \$3 is a price\./, "code is code, and an escaped dollar is a dollar");
    assert.match(page, /<meta name="description" content="Euler(?:'|&#39;)s identity, eiπ\+1=0, costs nothing;/, "the description reads the formula, not its TeX twice");
    const id = JSON.parse(tree.get("blyg/_registry.json") ?? "null")?.items?.["001-ash-eels"]?.id
      ?? [...tree.keys()].find((k) => /^items\/[^/]+\.json$/.test(k) && k !== "items/index.json")?.slice(6, -5);
    const item = JSON.parse(tree.get(`items/${id}.json`));
    assert.match(item.content_md, /Euler's identity, \$e\^\{i\\pi\}\+1=0\$, costs nothing/);
    assert.match(item.content_md, /\$\$\\sum_\{n=1\}\^\\infty \\frac\{1\}\{n\^2\}=\\frac\{\\pi\^2\}\{6\}\$\$/);
    assert.match(item.content_html, /<annotation encoding="application\/x-tex">/);
  } finally {
    site.dispose();
  }
});
