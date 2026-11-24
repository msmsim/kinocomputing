// Fooling the oracle: each mutant breaks one promised behaviour in a copy of
// tools/, and the oracle suite must fail against it. A mutant that survives is
// a hole in the oracle, not a pass. Run by hand; it takes a few minutes.
//
//   node test/mutants.mjs [name…]

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const RUNS = process.env.ORACLE_RUNS ?? "120";

const MUTANTS = {
  "version-time-always-page": ["blyg.mjs", "const at = paged > last.at ? paged : toUtc(now);", "const at = paged;"],
  "no-mass-withdrawal-guard": ["build-stream.mjs", "withdrawals > MAX_WITHDRAWALS && !massWithdrawal", "withdrawals > 99"],
  "feed-keeps-withdrawn-history": ["blyg.mjs", "(item.withdrawn ? item.entry.changelog.slice(-1) : item.entry.changelog)", "(item.entry.changelog)"],
  "change-note-dropped": ["blyg.mjs", "note: (fresh && note.changeNote) || null,", "note: null,"],
  "no-tombstone": ["build-stream.mjs", "else site.set(`${page}.html`, renderTombstone(entry, page));", "else {}"],
  "relative-urls-kept": ["blyg.mjs", "    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return whole;", "    return whole;"],
  "no-retitle-redirect": ["build-stream.mjs", "for (const old of [...(entry.moved_from ?? []), page]) {", "for (const old of [page]) {"],
  "no-head-links": ["build-stream.mjs", "updated = withVersions(withHeadLinks(updated, INDEX_PATH, entry.id), renderVersions(entry, note.path));", "updated = withVersions(updated, renderVersions(entry, note.path));"],
  "hash-of-html": ["blyg.mjs", "hash = contentHash(htmlToMarkdown(note.content, { quote: resolve }));", "hash = contentHash(note.content);"],
  "pin-not-on-unchanged": ["blyg.mjs", "    if (note.pin && fresh) {", "    if (note.pin && fresh && entry?.hash !== hash) {"],
  // Rewriting a pin with the bytes it already has is unobservable, so the
  // write-once rule is checked through what a rewrite would change: the time.
  "pin-doc-time-drifts": ["blyg.mjs", "        at: event.at,\n        note: event.note,", "        at: toUtc(Date.now() + 1000),\n        note: event.note,"],
  "version-on-rerender": ["blyg.mjs", "} else if (entry.hash !== hash || entry.withdrawn) {", "} else if (entry.hash !== hash || entry.withdrawn || fresh) {"],
  "site-links-open-new-tabs": ["build-stream.mjs", "return withAnalytics(withSameSiteLinks(html));", "return withAnalytics(html);"],
  "quotes-unnamed": ["build-stream.mjs", "From <a href=\"${href}\">${quotedTitle(slug, target.page)}</a>", "<a href=\"${href}\">quoted</a>"],
  "no-frozen-page": ["build-stream.mjs", "    site.set(name, renderPinned(entry, page, JSON.parse(source),", "    if (0) site.set(name, renderPinned(entry, page, JSON.parse(source),"],
  "frozen-title-not-promoted": ["build-stream.mjs", "    content, datetime_iso: pin.at, datetime: displayTime(pin.at),", "    content: pin.content_html, datetime_iso: pin.at, datetime: displayTime(pin.at),"],
  "generated-not-wrapped": ["blyg.mjs", "html: entry.generated ? `<div class=\"blyg-tk-gen\">\\n${html}\\n</div>` : html };", "html };"],
  // Not "generated-kept-on-endcap": an endcap's document is built without
  // provenance whatever the registry holds, and a return records the version
  // afresh, so keeping it is unobservable — an equivalent mutant.
  "generated-sticks-across-versions": ["blyg.mjs", "      else delete entry.generated;\n", "\n"],
  "requests-ship": ["build-stream.mjs", "updated = withoutChangeNote(withoutPinRequest(updated));", ""],
  // Threads and quotes (P21, P22): killed by threads.test.mjs and conformance.
  "quotes-not-baked": ["blyg.mjs", "const baked = entry.quotes?.length ? withQuotes(note.content, entry.quotes) : note.content;", "const baked = note.content;"],
  "quotes-follow-the-source": ["blyg.mjs", "    const current = items[note.slug];\n", "    const current = items[note.slug];\n    if (resolved.length) current.quotes = resolved;\n"],
  "republish-keeps-old-snapshot": ["blyg.mjs", "      if (resolved.length) entry.quotes = resolved;\n      else delete entry.quotes;\n", ""],
  "selection-unchecked": ["blyg.mjs", "if (!textContent(resolved[i].html).includes(exact)) throw", "if (false) throw"],
  "threads-quotable": ["blyg.mjs", "if (baseKind(target) !== \"fragment\") throw", "if (false) throw"],
  "fragments-quote": ["blyg.mjs", "if (quoted.length && kind !== \"thread\") throw", "if (false) throw"],
  "kind-follows-the-page": ["blyg.mjs", "const kind = entry ? baseKind(entry) :", "const kind = entry && !note.kind ? baseKind(entry) : note.kind ? note.kind :"],
  "no-registration-order": ["blyg.mjs", "const ordered = [...notes].sort((a, b) => quotes(a) - quotes(b));", "const ordered = notes;"],
  // Not "endcap-keeps-transclusions": withdrawal drops the registry's quotes
  // and a return re-resolves them, so an endcap has none to keep — equivalent.
  "partial-as-whole": ["blyg.mjs", "        resolved[i].exact = exact;\n", "\n"],
  "placeholder-ships": ["build-stream.mjs", "  note.content = baked ?? note.content.replace(", "  note.content = note.content ?? note.content.replace("],
};

const only = process.argv.slice(2);
const results = [];
for (const [name, [file, from, to]] of Object.entries(MUTANTS)) {
  if (only.length && !only.includes(name)) continue;
  const dir = mkdtempSync(join(tmpdir(), `mutant-${name}-`));
  cpSync(join(REPO, "tools"), dir, { recursive: true });
  const path = join(dir, file);
  const source = readFileSync(path, "utf8");
  if (!source.includes(from)) {
    results.push([name, "STALE (the code it mutates has changed)"]);
    console.log(`${name}: ${results.at(-1)[1]}`);
    continue;
  }
  writeFileSync(path, source.replace(from, to));
  const run = spawnSync(process.execPath, ["--test", "test/oracle.test.mjs", "test/threads.test.mjs"], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, ORACLE_TOOLS: dir, ORACLE_RUNS: RUNS },
  });
  rmSync(dir, { recursive: true, force: true });
  const killed = run.status !== 0;
  const why = (run.stdout.match(/\[cause\]: AssertionError[^:]*: ([^\n]*)/) ?? [])[1] ?? "";
  results.push([name, killed ? `killed — ${why.slice(0, 110)}` : "SURVIVED"]);
  console.log(`${name}: ${results.at(-1)[1]}`);
}
const survived = results.filter(([, r]) => !r.startsWith("killed"));
console.log(`\n${results.length - survived.length}/${results.length} mutants killed`);
process.exit(survived.length ? 1 : 0);
