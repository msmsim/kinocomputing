// Fooling the oracle: each mutant breaks one promised behaviour in a copy of
// tools/, and the oracle suite must fail against it. A mutant that survives is
// a hole in the oracle, not a pass. Run by hand.
//
//   node test/mutants.mjs [name…]
//
// The oracle's files run side by side, and a mutant stops at the first file
// that fails. test/mutants.json remembers which file killed each mutant; that
// file runs first, alone, next time, and the rest only if it passes, so
// several mutants can run at once (MUTANT_JOBS, default one per core). A
// mutant is capped at MUTANT_TIMEOUT_MS (default 300 s); one that hits the
// cap counts as survived.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const RUNS = process.env.ORACLE_RUNS ?? "120";
const FILES = ["test/oracle.test.mjs", "test/examples.test.mjs", "test/threads.test.mjs"];
const JOBS = Math.max(1, Number(process.env.MUTANT_JOBS ?? availableParallelism()));
const TIMEOUT_MS = Number(process.env.MUTANT_TIMEOUT_MS ?? 300_000);
const KILLERS_PATH = join(REPO, "test/mutants.json");
const killers = existsSync(KILLERS_PATH) ? JSON.parse(readFileSync(KILLERS_PATH, "utf8")) : {};

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
  "site-links-open-new-tabs": ["build-stream.mjs", "return withAnalytics(withSameSiteLinks(withThemeHead(html)));", "return withAnalytics(withThemeHead(html));"],
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

/** One oracle file against a mutant's tools: resolves true if it passes. */
function runFile(tools, file, stops) {
  return new Promise((resolve) => {
    // Its own process group, so a stop takes the builds it started with it.
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
      cwd: REPO, detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ORACLE_TOOLS: tools, ORACLE_RUNS: RUNS },
    });
    const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    stops.push(stop);
    let failed = false;
    let tail = "";
    child.stdout.on("data", (chunk) => {
      tail = (tail + chunk).slice(-4000);
      if (!failed && /^\s*not ok /m.test(tail)) { failed = true; stop(); }
    });
    child.on("close", (code) => resolve(!failed && code === 0));
  });
}

/** Files side by side until one fails: that file, null if all passed, or "timed out". */
function firstFailure(tools, files) {
  return new Promise((resolve) => {
    const stops = [];
    let done = false;
    let left = files.length;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); stops.forEach((s) => s()); resolve(value); };
    const timer = setTimeout(() => finish("timed out"), TIMEOUT_MS);
    for (const file of files) runFile(tools, file, stops).then((passed) => (!passed ? finish(file) : --left === 0 && finish(null)));
  });
}

async function worker(queue, results) {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [name, [file, from, to]] = next;
    const dir = mkdtempSync(join(tmpdir(), `mutant-${name}-`));
    try {
      cpSync(join(REPO, "tools"), dir, { recursive: true });
      const path = join(dir, file);
      const source = readFileSync(path, "utf8");
      if (!source.includes(from)) {
        results.push([name, "STALE (the code it mutates has changed)"]);
        console.log(`${name}: ${results.at(-1)[1]}`);
        continue;
      }
      writeFileSync(path, source.replace(from, to));
      const started = Date.now();
      const known = FILES.includes(killers[name]) ? killers[name] : null;
      let killer = known ? await firstFailure(dir, [known]) : null;
      if (!killer) killer = await firstFailure(dir, FILES.filter((f) => f !== known));
      const killed = killer && killer !== "timed out";
      if (killed) killers[name] = killer;
      results.push([name, killed ? `killed by ${killer.slice(5)}` : killer === "timed out" ? "TIMED OUT" : "SURVIVED"]);
      console.log(`${name}: ${results.at(-1)[1]} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const only = process.argv.slice(2);
const queue = Object.entries(MUTANTS).filter(([name]) => !only.length || only.includes(name));
const results = [];
const started = Date.now();
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, () => worker(queue, results)));
writeFileSync(KILLERS_PATH, `${JSON.stringify(Object.fromEntries(Object.entries(killers).filter(([n]) => n in MUTANTS).sort()), null, 2)}\n`);
const survived = results.filter(([, r]) => !r.startsWith("killed"));
console.log(`\n${results.length - survived.length}/${results.length} mutants killed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
process.exit(survived.length ? 1 : 0);
