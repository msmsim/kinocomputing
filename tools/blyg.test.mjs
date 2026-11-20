// node --test "tools/*.test.mjs"

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  htmlToMarkdown, contentHash, newId, toUtc, updateRegistry, serializeRegistry,
  buildSurfaces, withHeadLinks, latestTime, withStamp,
  renderVersions, withVersions,
  asksForPin, withoutPinRequest, buildPins, renderWithdrawn,
  renderPinnedVersions, withPinnedVersions, changeNoteOf, withoutChangeNote,
} from "./blyg.mjs";

const md = (html) => htmlToMarkdown(html);

test("paragraphs are separated by a blank line, with no trailing newline", () => {
  assert.equal(md("\n<p>One.</p>\n<p>Two.</p>\n"), "One.\n\nTwo.");
});

test("emphasis, strong and links", () => {
  assert.equal(
    md('<p>An <em>idea</em>, a <strong>claim</strong>, a <a href="https://example.com/x">link</a>.</p>'),
    "An *idea*, a **claim**, a [link](https://example.com/x)."
  );
});

test("link targets with brackets or spaces are angle-wrapped", () => {
  assert.equal(
    md('<p><a href="https://en.wikipedia.org/wiki/Transformation_(function)">T</a></p>'),
    "[T](<https://en.wikipedia.org/wiki/Transformation_(function)>)"
  );
});

test("a class on a paragraph is dropped", () => {
  assert.equal(
    md('<p class="source"><a href="https://example.com/">Title ↗</a></p>'),
    "[Title ↗](https://example.com/)"
  );
});

test("unordered lists", () => {
  assert.equal(
    md("<p>Stack:</p>\n<ul>\n<li>A <strong>frontier</strong> LLM</li>\n<li>A canvas</li>\n</ul>"),
    "Stack:\n\n- A **frontier** LLM\n- A canvas"
  );
});

test("blockquotes prefix every line, blank ones included", () => {
  assert.equal(md("<blockquote><p>One.</p><p>Two.</p></blockquote>"), "> One.\n>\n> Two.");
});

test("common named entities are decoded", () => {
  assert.equal(md("<p>a &hellip; b &mdash; c</p>"), "a … b — c");
});

test("entities are decoded", () => {
  assert.equal(md("<p>a &amp; b &quot;c&quot; d &gt; e &#8217;</p>"), 'a & b "c" d > e ’');
});

test("markdown-significant characters in text are escaped", () => {
  assert.equal(md("<p>a *b* _c_ [d] `e` \\ &lt;f</p>"), "a \\*b\\* \\_c\\_ \\[d\\] \\`e\\` \\\\ \\<f");
});

test("lines that would open a block are escaped", () => {
  assert.equal(md("<p># not a heading</p>"), "\\# not a heading");
  assert.equal(md("<p>&gt; not a quote</p>"), "\\> not a quote");
  assert.equal(md("<p>- not a list</p>"), "\\- not a list");
  assert.equal(md("<p>1. not a list</p>"), "1\\. not a list");
  assert.equal(md("<p>1 · Maya\n2. Jonah</p>"), "1 · Maya\n2\\. Jonah");
});

test("soft line breaks are kept and line edges trimmed", () => {
  assert.equal(md("<p> One  two \n  three </p>"), "One  two\nthree");
});

test("inline code is fenced past any backticks inside it, and not escaped", () => {
  assert.equal(md("<p>Lineage is <code>stub_of</code>.</p>"), "Lineage is `stub_of`.");
  assert.equal(md("<p><code>a &lt; b*c</code></p>"), "`a < b*c`");
  assert.equal(md("<p><code>a`b</code> <code>`x`</code></p>"), "``a`b`` `` `x` ``");
});

test("strikethrough, and the b and i spellings of strong and em", () => {
  assert.equal(md("<p><del>a</del> <s>b</s> <b>c</b> <i>d</i></p>"), "~~a~~ ~~b~~ **c** *d*");
});

test("a line break is a hard break", () => {
  assert.equal(md("<p>a<br>b<br/>c<br />d</p>"), "a\\\nb\\\nc\\\nd");
});

test("images", () => {
  assert.equal(md('<p><img src="/notes/a.png" alt="A [cat]"></p>'), "![A \\[cat\\]](/notes/a.png)");
  assert.equal(md('<p><img src="a b.png"/></p>'), "![](<a b.png>)");
});

test("headings and rules", () => {
  assert.equal(
    md("<h2>A <em>title</em></h2>\n<p>Body.</p>\n<hr>\n<h6>End</h6>"),
    "## A *title*\n\nBody.\n\n---\n\n###### End"
  );
});

test("ordered lists are numbered from one", () => {
  assert.equal(md("<ol>\n<li>One</li>\n<li>Two\nmore</li>\n</ol>"), "1. One\n2. Two\n   more");
});

test("nested lists and blocks inside an item are indented under it", () => {
  assert.equal(
    md("<ul>\n<li>A\n<ol>\n<li>B</li>\n<li>C</li>\n</ol>\n</li>\n<li>D</li>\n</ul>"),
    "- A\n  1. B\n  2. C\n- D"
  );
  assert.equal(md("<ul><li><p>A</p><p>B</p></li></ul>"), "- A\n  \n  B");
});

test("code blocks are fenced, verbatim, with their language", () => {
  assert.equal(
    md('<pre><code class="language-js">if (a &lt; b) {\n  *x*\n}\n</code></pre>'),
    "```js\nif (a < b) {\n  *x*\n}\n```"
  );
  assert.equal(md("<pre>a\n```\nb</pre>"), "````\na\n```\nb\n````");
});

test("anything outside the known subset throws", () => {
  assert.throws(() => md("<table><tr><td>a</td></tr></table>"), /unsupported block element <table>/);
  assert.throws(() => md("<p>a<span>b</span></p>"), /unsupported inline element <span>/);
  assert.throws(() => md("stray <p>a</p>"), /text outside a block/);
  assert.throws(() => md("<p>a &zwj; b</p>"), /unknown entity/);
  assert.throws(() => md("<p>a"), /unclosed <p>/);
});

test("content_hash is sha256 over the UTF-8 markdown", () => {
  // The spec's own example value: SHA-256 of "test".
  assert.equal(
    contentHash("test"),
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
  );
  assert.notEqual(contentHash("é"), contentHash("e"));
});

test("every published note converts", async () => {
  const files = (await readdir("notes"))
    .filter((name) => name.endsWith(".html") && name !== "index.html" && !name.startsWith("_"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const html = await readFile(join("notes", file), "utf8");
    const body = html.slice(html.indexOf("<main>") + "<main>".length, html.indexOf("</main>"));
    assert.doesNotThrow(() => htmlToMarkdown(body), `${file} failed to convert`);
  }
});

test("ids are 26 characters of lowercase Crockford base32", () => {
  const ids = new Set(Array.from({ length: 200 }, newId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-hjkmnp-tv-z]{26}$/);
  // 128 bits in 130 bits of encoding: the leading character carries only 3.
  for (const id of ids) assert.match(id[0], /[0-7]/);
});

test("timestamps are converted to UTC at whole seconds", () => {
  assert.equal(toUtc("2026-09-27T22:18:53+01:00"), "2026-09-27T21:18:53Z");
  assert.equal(toUtc("2026-09-28T06:58:43.201Z"), "2026-09-28T06:58:43Z");
});

const note = (slug, iso, content) => ({ slug, iso, content });
const counter = () => { let n = 0; return () => `id${n += 1}`; };
const NOW = "2026-10-03T12:00:00Z";

test("a first sighting registers the note at version 1", () => {
  const { registry, events } = updateRegistry(
    {}, [note("a", "2026-09-27T22:18:53+01:00", "<p>One.</p>")], { now: NOW, makeId: counter() }
  );
  assert.deepEqual(registry.items.a, {
    id: "id1",
    created: "2026-09-27T21:18:53Z",
    hash: contentHash("One."),
    changelog: [{ version: 1, at: "2026-09-27T21:18:53Z", note: null }],
  });
  assert.deepEqual(events, [{ type: "new", slug: "a" }]);
});

test("an unchanged note is left alone, whatever happens to its page or time", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const { registry, events } = updateRegistry(
    first, [note("a", "2026-09-05T10:00:00Z", "\n<p>One.</p>\n")], { now: NOW }
  );
  assert.deepEqual(registry, first);
  assert.deepEqual(events, []);
});

test("changed content is a new version under the same id, timed from now", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const { registry, events } = updateRegistry(
    first, [note("a", "2026-09-01T10:00:00Z", "<p>Two.</p>")], { now: NOW }
  );
  assert.equal(registry.items.a.id, "id1");
  assert.equal(registry.items.a.created, "2026-09-01T10:00:00Z");
  assert.equal(registry.items.a.hash, contentHash("Two."));
  assert.deepEqual(registry.items.a.changelog, [
    { version: 1, at: "2026-09-01T10:00:00Z", note: null },
    { version: 2, at: NOW, note: null },
  ]);
  assert.deepEqual(events, [{ type: "version", slug: "a", version: 2 }]);
  // The input is not modified.
  assert.equal(first.items.a.changelog.length, 1);
});

test("a new version takes the page's time when that has moved on", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const { registry } = updateRegistry(
    first, [note("a", "2026-09-02T09:30:00+01:00", "<p>Two.</p>")], { now: NOW }
  );
  assert.equal(registry.items.a.changelog[1].at, "2026-09-02T08:30:00Z");
});

test("a note that will not convert is reported and its entry kept", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const { registry, events } = updateRegistry(
    first,
    [note("a", "2026-09-01T10:00:00Z", "<table></table>"), note("b", "2026-09-02T10:00:00Z", "<p><span>x</span></p>")],
    { now: NOW }
  );
  assert.deepEqual(registry, first);
  assert.deepEqual(events.map((e) => [e.type, e.slug]), [["unconverted", "a"], ["unconverted", "b"]]);
});

test("a registered note whose page file is gone is withdrawn: an empty endcap version, once", () => {
  const first = updateRegistry({}, [pinning("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const { registry, events } = updateRegistry(first, [], { now: NOW });
  assert.deepEqual(registry.items.a, {
    id: "id1",
    created: "2026-09-01T10:00:00Z",
    hash: contentHash(""),
    withdrawn: true,
    changelog: [
      { version: 1, at: "2026-09-01T10:00:00Z", note: null, pinned: true },
      { version: 2, at: NOW, note: null },
    ],
  });
  assert.deepEqual(events, [{ type: "withdrawn", slug: "a", version: 2 }]);

  // Later builds find the tombstone where the page was, and leave it be.
  const later = updateRegistry(registry, [], { now: "2026-10-05T12:00:00Z", present: new Set(["a"]) });
  assert.deepEqual(later.registry, registry);
  assert.deepEqual(later.events, []);
});

test("a page that is still there but no longer reads as a note is reported, not withdrawn", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const { registry, events } = updateRegistry(first, [], { now: NOW, present: new Set(["a"]) });
  assert.deepEqual(registry, first);
  assert.deepEqual(events, [{ type: "missing", slug: "a" }]);
});

test("a withdrawn note whose page comes back returns as the next version, same id", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const gone = updateRegistry(first, [], { now: NOW }).registry;
  const { registry, events } = updateRegistry(
    gone, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: "2026-10-05T12:00:00Z", present: new Set(["a"]) }
  );
  assert.equal(registry.items.a.id, "id1");
  assert.equal(registry.items.a.withdrawn, undefined);
  assert.equal(registry.items.a.hash, contentHash("One."));
  assert.deepEqual(registry.items.a.changelog.map((e) => e.version), [1, 2, 3]);
  assert.deepEqual(events, [{ type: "version", slug: "a", version: 3 }]);
});

const pinning = (slug, iso, content) => ({ ...note(slug, iso, content), pin: true });

test("a pin request pins the version it arrives with: new, edited or unchanged", () => {
  // On first sight.
  const fresh = updateRegistry({}, [pinning("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() });
  assert.deepEqual(fresh.registry.items.a.changelog,
    [{ version: 1, at: "2026-09-01T10:00:00Z", note: null, pinned: true }]);
  assert.deepEqual(fresh.events.map((e) => e.type), ["new", "pinned"]);

  // With an edit: the new version is pinned, the old one is not.
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const edited = updateRegistry(first, [pinning("a", "2026-09-01T10:00:00Z", "<p>Two.</p>")], { now: NOW });
  assert.deepEqual(edited.registry.items.a.changelog.map((e) => [e.version, e.pinned ?? false]),
    [[1, false], [2, true]]);
  assert.deepEqual(edited.events.at(-1), { type: "pinned", slug: "a", version: 2 });

  // With no edit: the live version is pinned after the fact, and no version is made.
  const after = updateRegistry(first, [pinning("a", "2026-09-01T10:00:00Z", "<p>One.</p>")], { now: NOW });
  assert.deepEqual(after.registry.items.a.changelog,
    [{ version: 1, at: "2026-09-01T10:00:00Z", note: null, pinned: true }]);
  assert.deepEqual(after.events, [{ type: "pinned", slug: "a", version: 1 }]);
});

test("a pin is asked for once: a repeat does nothing, and an edit without one is not pinned", () => {
  const pinned = updateRegistry({}, [pinning("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const again = updateRegistry(pinned, [pinning("a", "2026-09-01T10:00:00Z", "<p>One.</p>")], { now: NOW });
  assert.deepEqual(again.registry, pinned);
  assert.deepEqual(again.events, []);

  const edited = updateRegistry(pinned, [note("a", "2026-09-01T10:00:00Z", "<p>Two.</p>")], { now: NOW });
  assert.deepEqual(edited.registry.items.a.changelog.map((e) => [e.version, e.pinned ?? false]),
    [[1, true], [2, false]]);
});

test("a note that will not convert is not pinned", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const { registry } = updateRegistry(first, [pinning("a", "2026-09-01T10:00:00Z", "<table></table>")], { now: NOW });
  assert.deepEqual(registry, first);
});

test("the registry serialises sorted by slug", () => {
  const text = serializeRegistry({ items: { b: { id: "2" }, a: { id: "1" } } });
  assert.deepEqual(Object.keys(JSON.parse(text).items), ["a", "b"]);
  assert.ok(text.endsWith("}\n"));
});

const SITE = {
  origin: "https://example.com/notes/",
  title: "Notes",
  description: "Notes & such.",
  author: { name: "A. Writer" },
  generator: "test/0.1",
  generatorUrl: "https://example.com/src",
};

test("surfaces: item documents, archive index and manifest", () => {
  const notes = [
    note("a", "2026-09-01T10:00:00Z", '<p>One <a href="/notes/b">b</a>.</p>'),
    note("b", "2026-09-02T10:00:00Z", "<p>Two.</p>"),
  ];
  const { registry } = updateRegistry({}, notes, { now: NOW, makeId: counter() });
  const files = buildSurfaces(registry, notes, SITE);
  assert.deepEqual([...files.keys()].sort(),
    ["blyg.json", "feed.xml", "items/id1.json", "items/id2.json", "items/index.json"]);

  assert.deepEqual(JSON.parse(files.get("items/id1.json")), {
    blyg: "0.3",
    id: "id1",
    kind: "fragment",
    origin: "https://example.com/notes/",
    page: "a",
    author: { name: "A. Writer" },
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    version: 1,
    content_md: "One [b](/notes/b).",
    content_html: '<p>One <a href="https://example.com/notes/b">b</a>.</p>',
    content_hash: contentHash("One [b](/notes/b)."),
    media: [],
    changelog: [{ version: 1, at: "2026-09-01T10:00:00Z", note: null }],
  });

  // Newest update first.
  assert.deepEqual(JSON.parse(files.get("items/index.json")), {
    updated: "2026-09-02T10:00:00Z",
    items: [
      { id: "id2", kind: "fragment", created: "2026-09-02T10:00:00Z", updated: "2026-09-02T10:00:00Z", version: 1 },
      { id: "id1", kind: "fragment", created: "2026-09-01T10:00:00Z", updated: "2026-09-01T10:00:00Z", version: 1 },
    ],
  });

  assert.deepEqual(JSON.parse(files.get("blyg.json")), {
    blyg: "0.3",
    level: 2,
    generator: "test/0.1",
    generator_url: "https://example.com/src",
    site: "https://example.com/notes/",
    title: "Notes",
    author: { name: "A. Writer" },
    feed: "feed.xml",
    items: "items/index.json",
    updated: "2026-09-02T10:00:00Z",
  });
});

test("surfaces: an edit shows as the new version with updated moved on", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const edited = [note("a", "2026-09-01T10:00:00Z", "<p>Two.</p>")];
  const { registry } = updateRegistry(first, edited, { now: NOW });
  const item = JSON.parse(buildSurfaces(registry, edited, SITE).get("items/id1.json"));
  assert.equal(item.version, 2);
  assert.equal(item.updated, NOW);
  assert.equal(item.created, "2026-09-01T10:00:00Z");
  assert.equal(item.content_md, "Two.");
  assert.equal(item.changelog.length, 2);
});

test("surfaces: a note that won't convert stays in the index without a new document", () => {
  const first = updateRegistry({}, [
    note("a", "2026-09-01T10:00:00Z", "<p>One.</p>"),
  ], { now: NOW, makeId: counter() }).registry;
  const files = buildSurfaces(first, [note("a", "2026-09-01T10:00:00Z", "<table></table>")], SITE);
  assert.deepEqual([...files.keys()].sort(), ["blyg.json", "feed.xml", "items/index.json"]);
  assert.doesNotMatch(files.get("feed.xml"), /<item>/);
  assert.equal(JSON.parse(files.get("items/index.json")).items.length, 1);
});

test("surfaces: a withdrawn note keeps an emptied document, its index entry, and one feed entry", () => {
  const a = note("a", "2026-09-01T10:00:00Z", "<p>One.</p>");
  const b = note("b", "2026-09-02T10:00:00Z", "<p>Two.</p>");
  let registry = updateRegistry({}, [a, b], { now: NOW, makeId: counter() }).registry;
  registry = updateRegistry(registry, [note("a", a.iso, "<p>One, edited.</p>"), b],
    { now: "2026-10-01T12:00:00Z" }).registry;
  registry = updateRegistry(registry, [b], { now: NOW }).registry;
  const files = buildSurfaces(registry, [b], SITE);

  assert.deepEqual(JSON.parse(files.get("items/id1.json")), {
    blyg: "0.3",
    id: "id1",
    kind: "withdrawn",
    origin: "https://example.com/notes/",
    page: "a",
    author: { name: "A. Writer" },
    created: "2026-09-01T10:00:00Z",
    updated: NOW,
    version: 3,
    content_md: "",
    content_html: "",
    content_hash: contentHash(""),
    media: [],
    changelog: [
      { version: 1, at: "2026-09-01T10:00:00Z", note: null },
      { version: 2, at: "2026-10-01T12:00:00Z", note: null },
      { version: 3, at: NOW, note: null },
    ],
  });

  const index = JSON.parse(files.get("items/index.json"));
  assert.deepEqual(index.items[0], { id: "id1", kind: "withdrawn", created: "2026-09-01T10:00:00Z", updated: NOW, version: 3 });
  assert.equal(index.items[1].kind, "fragment");

  // One entry for the withdrawal, titled so and empty; v1 and v2 are gone.
  const feed = files.get("feed.xml");
  assert.deepEqual(feed.match(/blyg:id\d:v\d/g), ["blyg:id1:v3", "blyg:id2:v1"]);
  const entry = feed.slice(feed.indexOf("<item>"), feed.indexOf("</item>"));
  assert.match(entry, /<title>withdrawn<\/title>/);
  assert.match(entry, /<description><!\[CDATA\[\]\]><\/description>/);
  assert.match(entry, /<blyg:kind>withdrawn<\/blyg:kind>/);
  assert.match(entry, /<link>https:\/\/example.com\/notes\/a<\/link>/);
});

const STUB_OF = {
  origin: "https://blyg.example.org/",
  id: "6cjkc91fsp0pqaw37gzacxksgk",
  version: 2,
  cited: { source: "Their Blyg", url: "https://blyg.example.org/t/6cjkc91fsp0pqaw37gzacxksgk", retrieved: NOW },
};
const stubbing = (slug, iso, content, stub = STUB_OF) => ({ ...note(slug, iso, content), stub });

test("a stub's reference is taken at registration and kept, whatever later sightings say", () => {
  const first = updateRegistry({}, [stubbing("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  assert.deepEqual(first.items.a.stub_of, STUB_OF);

  // A later build resolves nothing (the note is registered) or something else: neither moves it.
  const edited = updateRegistry(first, [stubbing("a", "2026-09-01T10:00:00Z", "<p>Two.</p>", { ...STUB_OF, version: 9 })],
    { now: NOW }).registry;
  assert.deepEqual(edited.items.a.stub_of, STUB_OF);
  const bare = updateRegistry(first, [note("a", "2026-09-01T10:00:00Z", "<p>Three.</p>")], { now: NOW }).registry;
  assert.deepEqual(bare.items.a.stub_of, STUB_OF);

  // And a note registered without one never becomes a stub.
  const plain = updateRegistry({}, [note("b", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const later = updateRegistry(plain, [stubbing("b", "2026-09-01T10:00:00Z", "<p>Two.</p>")], { now: NOW }).registry;
  assert.equal(later.items.b.stub_of, undefined);
});

test("surfaces: a stub is a thread carrying stub_of and no transclusions, everywhere its kind is said", () => {
  const notes = [stubbing("a", "2026-09-01T10:00:00Z", "<p>One.</p>"), note("b", "2026-09-02T10:00:00Z", "<p>Two.</p>")];
  const { registry } = updateRegistry({}, notes, { now: NOW, makeId: counter() });
  const files = buildSurfaces(registry, notes, SITE);

  const item = JSON.parse(files.get("items/id1.json"));
  assert.equal(item.kind, "thread");
  assert.deepEqual(item.transclusions, []);
  assert.deepEqual(item.stub_of, STUB_OF);
  const fragment = JSON.parse(files.get("items/id2.json"));
  assert.equal(fragment.kind, "fragment");
  assert.ok(!("transclusions" in fragment) && !("stub_of" in fragment));

  const kinds = Object.fromEntries(JSON.parse(files.get("items/index.json")).items.map((i) => [i.id, i.kind]));
  assert.deepEqual(kinds, { id1: "thread", id2: "fragment" });
  assert.deepEqual(files.get("feed.xml").match(/<blyg:kind>\w+<\/blyg:kind>/g),
    ["<blyg:kind>fragment</blyg:kind>", "<blyg:kind>thread</blyg:kind>"]);
});

test("surfaces: a withdrawn stub's endcap drops stub_of and keeps an empty transclusions", () => {
  const a = stubbing("a", "2026-09-01T10:00:00Z", "<p>One.</p>");
  let registry = updateRegistry({}, [a], { now: NOW, makeId: counter() }).registry;
  registry = updateRegistry(registry, [], { now: NOW }).registry;
  const item = JSON.parse(buildSurfaces(registry, [], SITE).get("items/id1.json"));
  assert.equal(item.kind, "withdrawn");
  assert.deepEqual(item.transclusions, []);
  assert.ok(!("stub_of" in item));
});

test("pins: a pinned stub carries its own citation", () => {
  const notes = [{ ...stubbing("a", "2026-09-01T10:00:00Z", "<p>One.</p>"), pin: true }];
  const { registry } = updateRegistry({}, notes, { now: NOW, makeId: counter() });
  const pin = JSON.parse(buildPins(registry, notes, SITE)[0].content);
  assert.equal(pin.kind, "thread");
  assert.deepEqual(pin.transclusions, []);
  assert.deepEqual(pin.stub_of, STUB_OF);
});

test("pins: a document for a pinned live version, carrying that version's content", () => {
  const notes = [
    pinning("a", "2026-09-01T10:00:00Z", '<p>One <a href="/x">x</a>.</p>'),
    note("b", "2026-09-02T10:00:00Z", "<p>Two.</p>"),
  ];
  const { registry } = updateRegistry({}, notes, { now: NOW, makeId: counter() });
  const pins = buildPins(registry, notes, SITE);
  assert.deepEqual(pins.map((pin) => [pin.slug, pin.version, pin.file]), [["a", 1, "items/id1/v1.json"]]);
  assert.deepEqual(JSON.parse(pins[0].content), {
    blyg: "0.3",
    id: "id1",
    kind: "fragment",
    version: 1,
    at: "2026-09-01T10:00:00Z",
    note: null,
    pinned: true,
    origin: "https://example.com/notes/",
    author: { name: "A. Writer" },
    content_md: "One [x](/x).",
    content_html: '<p>One <a href="https://example.com/x">x</a>.</p>',
    content_hash: contentHash("One [x](/x)."),
  });

  // The item document's changelog says so too, and the feed gains nothing (§7).
  const files = buildSurfaces(registry, notes, SITE);
  assert.equal(JSON.parse(files.get("items/id1.json")).changelog[0].pinned, true);
  assert.equal(files.get("feed.xml").match(/<item>/g).length, 2);
});

test("pins: only the live version can be written, and only while the page still says it", () => {
  const first = updateRegistry({}, [pinning("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  // Edited on, unpinned: v1's content is no longer in hand.
  const edit = [note("a", "2026-09-01T10:00:00Z", "<p>Two.</p>")];
  assert.deepEqual(buildPins(updateRegistry(first, edit, { now: NOW }).registry, edit, SITE), []);
  // The page has moved to something that won't convert: nothing to trust.
  assert.deepEqual(buildPins(first, [note("a", "2026-09-01T10:00:00Z", "<table></table>")], SITE), []);
});

test("a pin request is found in a page and taken out again, leaving the line it was on", () => {
  const inline = '    <link rel="stylesheet" href="/notes/note.css"><meta name="blyg:pin" content="true">\n</head>';
  assert.equal(asksForPin(inline), true);
  assert.equal(withoutPinRequest(inline), '    <link rel="stylesheet" href="/notes/note.css">\n</head>');
  const ownLine = '<head>\n<meta name="blyg:pin" content="true">\n</head>';
  assert.equal(withoutPinRequest(ownLine), "<head>\n</head>");
  assert.equal(asksForPin("<head>\n</head>"), false);
  assert.equal(withoutPinRequest("<head>\n</head>"), "<head>\n</head>");
});

test("only a request for true pins: a template's unfilled or empty placeholder does not", () => {
  // Subset's receiver leaves the if:pin section in with {{pin}} unfilled.
  const unfilled = '<link rel="stylesheet" href="/notes/note.css"><!-- if:pin --><meta name="blyg:pin" content="{{pin}}"><!-- /if:pin -->';
  assert.equal(asksForPin(unfilled), false);
  assert.equal(asksForPin('<meta name="blyg:pin" content="">'), false);
  assert.equal(asksForPin('<meta name="blyg:pin" content="false">'), false);
});

const pinnedNav = (entry, version) => {
  const { before, after } = renderPinnedVersions(entry, "/notes/a", version);
  return `${before}[time]${after}`;
};

test("pinned page versions: pins and the live version as links, the one shown in bold before its time", () => {
  const entry = versions([1, true], [2, true], [3], [4, true], [5]);
  assert.equal(pinnedNav(entry, 2),
    '<span class="versions"><a href="/notes/a-v1" target="_self">v1</a> · <strong>v2</strong> · </span>[time]'
    + '<span class="versions"> · <a href="/notes/a-v4" target="_self">v4</a> · <a href="/notes/a" target="_self">v5</a></span>');
  // First in the list: nothing before it but itself. v3 was never pinned, so never named.
  assert.equal(pinnedNav(entry, 1),
    '<span class="versions"><strong>v1</strong> · </span>[time]'
    + '<span class="versions"> · <a href="/notes/a-v2" target="_self">v2</a> · <a href="/notes/a-v4" target="_self">v4</a>'
    + ' · <a href="/notes/a" target="_self">v5</a></span>');
});

test("pinned page versions: a pinned live version links the note, from its own page and from the others", () => {
  const entry = versions([1, true], [2, true]);
  assert.equal(pinnedNav(entry, 2),
    '<span class="versions"><a href="/notes/a-v1" target="_self">v1</a> · '
    + '<a href="/notes/a" target="_self"><strong>v2</strong></a> · </span>[time]');
  assert.equal(pinnedNav(entry, 1),
    '<span class="versions"><strong>v1</strong> · </span>[time]'
    + '<span class="versions"> · <a href="/notes/a" target="_self">v2</a></span>');
});

test("pinned page versions: a withdrawn note's pins end on the word, linking its tombstone", () => {
  const entry = { ...versions([1, true], [2], [3]), withdrawn: true };
  assert.equal(pinnedNav(entry, 1),
    '<span class="versions"><strong>v1</strong> · </span>[time]'
    + '<span class="versions"> · <a href="/notes/a" target="_self">withdrawn</a></span>');
});

test("pinned page versions go either side of the footer stamp's time, and only there", () => {
  const page = [
    "<main>",
    '<p class="stamp">in main</p>',
    "</main>",
    '<p class="stamp"><a href="/notes/a-v2" target="_self"><time datetime="t">3 Oct 2026, 13:00</time></a></p>',
  ].join("\n");
  assert.equal(withPinnedVersions(page, { before: "[b]", after: "[a]" }), [
    "<main>",
    '<p class="stamp">in main</p>',
    "</main>",
    '<p class="stamp">[b]<a href="/notes/a-v2" target="_self"><time datetime="t">3 Oct 2026, 13:00</time></a>[a]</p>',
  ].join("\n"));
});

test("head links are added before </head> and replaced on a second pass", () => {
  const page = "<head>\n    <title>x</title>\n</head>\n<body></body>\n";
  const once = withHeadLinks(page, "/notes/", "id1");
  assert.equal(once,
    "<head>\n    <title>x</title>\n"
    + '    <link rel="blyg" href="/notes/">\n'
    + '    <link rel="alternate" type="application/json" href="/notes/items/id1.json">\n'
    + "</head>\n<body></body>\n");
  assert.equal(withHeadLinks(once, "/notes/", "id1"), once);
  assert.match(withHeadLinks(once, "/notes/", "id2"), /items\/id2\.json/);
  assert.doesNotMatch(withHeadLinks(once, "/notes/", "id2"), /id1/);
});

test("head links leave an RSS alternate alone", () => {
  const page = '<head>\n    <link rel="alternate" type="application/rss+xml" href="/f.xml">\n</head>\n';
  assert.match(withHeadLinks(page, "/notes/", "id1"), /application\/rss\+xml/);
});

test("feed: channel carries the manifest hook, entries are per version", () => {
  const notes = [
    note("a", "2026-09-01T10:00:00Z", '<p>One <a href="/notes/b">b</a> &amp; more.</p>'),
    note("b", "2026-09-02T10:00:00Z", "<p>Two.</p>"),
  ];
  const { registry } = updateRegistry({}, notes, { now: NOW, makeId: counter() });
  const feed = buildSurfaces(registry, notes, SITE).get("feed.xml");

  assert.match(feed, /<rss version="2.0" xmlns:blyg="https:\/\/blygger.org\/ns\/0.1"/);
  assert.match(feed, /<title>Notes<\/title>\n    <link>https:\/\/example.com\/notes\/<\/link>/);
  assert.match(feed, /<description>Notes &amp; such.<\/description>/);
  assert.match(feed, /<lastBuildDate>Wed, 02 Sep 2026 10:00:00 GMT<\/lastBuildDate>/);
  assert.match(feed, /<blyg:manifest>https:\/\/example.com\/notes\/blyg.json<\/blyg:manifest>/);

  const entries = feed.split("<item>").slice(1);
  assert.equal(entries.length, 2);
  // Newest first.
  assert.match(entries[0], /<guid isPermaLink="false">blyg:id2:v1<\/guid>/);
  assert.equal(entries[1].trimEnd().split("\n").slice(0, 12).join("\n"), [
    "",
    '      <guid isPermaLink="false">blyg:id1:v1</guid>',
    "      <link>https://example.com/notes/a</link>",
    "      <title>One b &amp; more.</title>",
    '      <description><![CDATA[<p>One <a href="https://example.com/notes/b">b</a> &amp; more.</p>]]></description>',
    "      <pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>",
    "      <dc:creator>A. Writer</dc:creator>",
    "      <blyg:id>id1</blyg:id>",
    "      <blyg:kind>fragment</blyg:kind>",
    "      <blyg:version>1</blyg:version>",
    "      <blyg:created>2026-09-01T10:00:00Z</blyg:created>",
    "      <blyg:item>https://example.com/notes/items/id1.json</blyg:item>",
  ].join("\n"));
});

test("feed: an edited note appears once per version, each with the latest content", () => {
  const first = updateRegistry({}, [note("a", "2026-09-01T10:00:00Z", "<p>One.</p>")],
    { now: NOW, makeId: counter() }).registry;
  const edited = [note("a", "2026-09-01T10:00:00Z", "<p>Two.</p>")];
  const { registry } = updateRegistry(first, edited, { now: NOW });
  const entries = buildSurfaces(registry, edited, SITE).get("feed.xml").split("<item>").slice(1);
  assert.equal(entries.length, 2);
  assert.match(entries[0], /blyg:id1:v2<\/guid>/);
  assert.match(entries[1], /blyg:id1:v1<\/guid>/);
  for (const entry of entries) {
    assert.match(entry, /<p>Two\.<\/p>/);
    assert.doesNotMatch(entry, /One/);
  }
  assert.match(entries[1], /<pubDate>Tue, 01 Sep 2026 10:00:00 GMT<\/pubDate>/);
});

test("feed: long content is excerpted at a word boundary, and the window is 50", () => {
  const long = `<p>${"word ".repeat(40).trim()}</p>`;
  const notes = Array.from({ length: 60 }, (_, i) =>
    note(`n${String(i).padStart(2, "0")}`, `2026-09-01T10:00:${String(i).padStart(2, "0")}Z`, long));
  const { registry } = updateRegistry({}, notes, { now: NOW, makeId: counter() });
  const feed = buildSurfaces(registry, notes, SITE).get("feed.xml");
  assert.equal(feed.split("<item>").length - 1, 50);
  assert.match(feed, new RegExp(`<title>${"word ".repeat(12).trim()}…</title>`));
  assert.match(feed.split("<item>")[1], /<link>https:\/\/example.com\/notes\/n59<\/link>/);
});

test("feed: the title excerpt drops inline tags without leaving gaps", () => {
  const notes = [note("a", "2026-09-01T10:00:00Z", '<p>As <a href="https://x.example/">Ben</a>, says.</p>\n<p>Then <em>this</em>.</p>')];
  const { registry } = updateRegistry({}, notes, { now: NOW, makeId: counter() });
  assert.match(buildSurfaces(registry, notes, SITE).get("feed.xml"), /<title>As Ben, says. Then this.<\/title>/);
});

test("latest time is the page's own until an edit moves the version time away", () => {
  const original = note("a", "2026-09-01T11:00:00.250+01:00", "<p>One.</p>");
  const first = updateRegistry({}, [original], { now: NOW, makeId: counter() }).registry;
  assert.equal(latestTime(first, original), "2026-09-01T11:00:00.250+01:00");

  const edited = note("a", "2026-09-01T11:00:00.250+01:00", "<p>Two.</p>");
  const { registry } = updateRegistry(first, [edited], { now: NOW });
  assert.equal(latestTime(registry, edited), NOW);

  // A page whose time moves without an edit keeps its recorded time.
  const moved = note("a", "2026-09-09T11:00:00Z", "<p>One.</p>");
  assert.equal(latestTime(first, moved), "2026-09-01T10:00:00Z");

  assert.equal(latestTime({ items: {} }, original), original.iso);
});

test("the footer stamp is rewritten, and only the footer stamp", () => {
  const page = [
    '<meta property="article:published_time" content="2026-09-01T11:00:00+01:00">',
    "<main>",
    '<p class="stamp"><time datetime="in-main">in main</time></p>',
    "</main>",
    '<footer class="notefoot">',
    '<p class="stamp"><a href="/notes/a" target="_self"><time datetime="2026-09-01T11:00:00+01:00">1 Sep 2026, 11:00</time></a></p>',
    "</footer>",
  ].join("\n");
  const stamped = withStamp(page, "2026-10-03T12:00:00Z", "3 Oct 2026, 13:00");
  assert.match(stamped, /<a href="\/notes\/a" target="_self"><time datetime="2026-10-03T12:00:00Z">3 Oct 2026, 13:00<\/time>/);
  assert.match(stamped, /published_time" content="2026-09-01T11:00:00\+01:00"/);
  assert.match(stamped, /<time datetime="in-main">in main<\/time>/);
  assert.equal(withStamp(stamped, "2026-10-03T12:00:00Z", "3 Oct 2026, 13:00"), stamped);
});

const versions = (...events) => ({ changelog: events.map(([version, pinned]) =>
  ({ version, at: NOW, note: null, ...(pinned ? { pinned: true } : {}) })) });

test("version links: nothing at v1, the live version alone once edited", () => {
  assert.equal(renderVersions(versions([1]), "/notes/a"), "");
  assert.equal(renderVersions(versions([1], [2], [3]), "/notes/a"),
    '<span class="versions"><strong>v3</strong> · </span>');
});

test("version links: pinned versions are links, unpinned ones are not listed", () => {
  assert.equal(
    renderVersions(versions([1], [2, true], [3], [4, true], [5]), "/notes/a"),
    '<span class="versions"><a href="/notes/a-v2" target="_self">v2</a> · '
    + '<a href="/notes/a-v4" target="_self">v4</a> · <strong>v5</strong> · </span>'
  );
  // A pinned live version is bold as ever, and links its own frozen page.
  assert.equal(renderVersions(versions([1], [2, true]), "/notes/a"),
    '<span class="versions"><a href="/notes/a-v2" target="_self"><strong>v2</strong></a> · </span>');
  // Which gives a note pinned at v1 something to say.
  assert.equal(renderVersions(versions([1, true]), "/notes/a"),
    '<span class="versions"><a href="/notes/a-v1" target="_self"><strong>v1</strong></a> · </span>');
});

test("a withdrawn note's page cites its pins and nothing else", () => {
  assert.equal(renderWithdrawn(versions([1], [2, true], [3], [4]), "/notes/a"),
    '<span class="versions"><a href="/notes/a-v2" target="_self">v2</a> · withdrawn · </span>');
  assert.equal(renderWithdrawn(versions([1], [2]), "/notes/a"),
    '<span class="versions">withdrawn · </span>');
});

test("version links go in the footer stamp, ahead of the time, and are replaced or removed", () => {
  const page = [
    '<nav class="back"><a href="/notes/" target="_self">← Notes</a></nav>',
    "<main>",
    '<p><span class="versions">in main</span></p>',
    "</main>",
    '<footer class="notefoot">',
    '<p class="stamp"><a href="/notes/a" target="_self"><time datetime="t">1 Sep 2026, 11:00</time></a></p>',
    "</footer>",
  ].join("\n");
  const v2 = '<span class="versions"><strong>v2</strong> · </span>';
  const v3 = '<span class="versions"><strong>v3</strong> · </span>';
  const once = withVersions(page, v2);
  assert.equal(once, page.replace('<p class="stamp">', `<p class="stamp">${v2}`));
  assert.equal(withVersions(once, v2), once);
  assert.equal(withVersions(once, v3), page.replace('<p class="stamp">', `<p class="stamp">${v3}`));
  assert.equal(withVersions(once, ""), page);
  assert.equal(withVersions(page, ""), page);

  // Links left in the back-nav by an earlier build are moved, not duplicated.
  const old = page.replace("← Notes</a>", `← Notes</a>${v2}`);
  assert.equal(withVersions(old, v2), once);

  // The stamp can still be re-timed with the links in place.
  assert.match(withStamp(once, "2026-10-03T12:00:00Z", "3 Oct 2026, 13:00"),
    /<p class="stamp"><span class="versions"><strong>v2<\/strong> · <\/span><a href="\/notes\/a" target="_self"><time datetime="2026-10-03T12:00:00Z">3 Oct 2026, 13:00<\/time>/);
});

// Change notes

const noting = (slug, iso, content, changeNote) => ({ ...note(slug, iso, content), changeNote });

test("a change note is read from the page, decoded, and an unfilled placeholder is not one", () => {
  assert.equal(changeNoteOf('<meta name="blyg:note" content="fixed the &quot;dates&quot; &amp; links">'),
    'fixed the "dates" & links');
  assert.equal(changeNoteOf('<meta name="blyg:note" content="  two\n  lines ">'), "two lines");
  assert.equal(changeNoteOf('<meta name="blyg:note" content="{{change_note}}">'), null);
  assert.equal(changeNoteOf('<meta name="blyg:note" content="">'), null);
  assert.equal(changeNoteOf("<head></head>"), null);
});

test("a change note is taken out of the page, its line included", () => {
  const page = '<head>\n    <meta name="blyg:note" content="x">\n</head>';
  assert.equal(withoutChangeNote(page), "<head>\n</head>");
  const inline = '<link rel="stylesheet" href="/notes/note.css"><meta name="blyg:note" content="x">\n';
  assert.equal(withoutChangeNote(inline), '<link rel="stylesheet" href="/notes/note.css">\n');
});

test("a change note goes on the version it arrives with, and never on v1", () => {
  const first = updateRegistry({}, [noting("a", "2026-09-01T10:00:00Z", "<p>One.</p>", "ignored")],
    { now: NOW, makeId: () => "id1" });
  assert.equal(first.registry.items.a.changelog[0].note, null);

  const edited = updateRegistry(first.registry,
    [noting("a", "2026-09-01T10:00:00Z", "<p>Two.</p>", "fixed a typo")], { now: NOW });
  assert.equal(edited.registry.items.a.changelog[1].note, "fixed a typo");

  // Unchanged content makes no version, so the note has nothing to attach to.
  const same = updateRegistry(edited.registry,
    [noting("a", "2026-09-01T10:00:00Z", "<p>Two.</p>", "another")], { now: NOW });
  assert.deepEqual(same.registry, edited.registry);
});

test("the live version's change note follows its number in the footer, escaped", () => {
  const entry = { changelog: [
    { version: 1, at: NOW, note: null },
    { version: 2, at: NOW, note: "<b>dates</b> & links" },
  ] };
  assert.equal(renderVersions(entry, "/notes/a"),
    '<span class="versions"><strong>v2</strong> <em class="change-note">— &lt;b&gt;dates&lt;/b&gt; &amp; links</em> · </span>');
  const { before } = renderPinnedVersions(
    { changelog: [{ version: 1, at: NOW, note: null }, { version: 2, at: NOW, note: "n", pinned: true }] },
    "/notes/a", 2);
  assert.match(before, /<strong>v2<\/strong><\/a> <em class="change-note">— n<\/em>/);
});

test("absolutize resolves every relative href and src against the item's page, and leaves the rest", async () => {
  const { absolutize } = await import("./blyg.mjs");
  const base = "https://kinocomputing.com/some-note";
  assert.equal(
    absolutize('<p><a href="/notes/001-a">a</a> <a href="#x">b</a> <a href="about?q=1&amp;r=2">c</a> <img src="img.png" alt=""></p>', base),
    '<p><a href="https://kinocomputing.com/notes/001-a">a</a> <a href="https://kinocomputing.com/some-note#x">b</a> '
      + '<a href="https://kinocomputing.com/about?q=1&amp;r=2">c</a> <img src="https://kinocomputing.com/img.png" alt=""></p>');
  const left = '<p><a href="https://example.com/x">x</a> <a href="mailto:a@b.c">m</a> <a href="//cdn.example/y">y</a></p>';
  assert.equal(absolutize(left, base), left.replace("//cdn.example/y", "https://cdn.example/y"));
});
