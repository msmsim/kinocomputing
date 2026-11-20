// Sends a Webmention for each stub of another origin's item (Blygger 0.4
// §15.2), so the stubbed author learns of it: it lands in their studio as a
// verified mention with the relation stub (§15.4).
//
// This is a static blyg and receives nothing (§15.7): this is the sending half
// only, run after deploy, because the receiver verifies by fetching our page
// and its item document, and a mention sent before those are live fails.
//
// State is one record per stub in blyg/_mentions.json, which this is the only
// writer of:
//
//   { [slug]: { phase: "stub"|"withdrawal", source, target, version, endpoint?,
//               status, code?, attempts, at, next_at? } }
//
// status: pending (our page isn't live with it yet; not an attempt), retry
// (network, 5xx or 429; due at next_at), sent (any 2xx), failed (other 4xx),
// unreachable (the target advertises no endpoint), abandoned (out of retries).
// Only pending and retry are ever looked at again.

import { get, itemDocument, normalizeOrigin, parseJson } from "./stub.mjs";

/** §15.2's RECOMMENDED retry schedule, in minutes. */
const BACKOFF = [15, 60, 240, 720, 1440];
const TERMINAL = new Set(["sent", "failed", "unreachable", "abandoned"]);

const toUtc = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The first `rel="webmention"` in a Link header, resolved against `base`. */
function fromLinkHeader(header, base) {
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = part.match(/<([^>]*)>\s*;(.*)/);
    if (match && /\brel="?[^"]*\bwebmention\b/i.test(match[2])) return new URL(match[1], base).href;
  }
  return null;
}

/** The first `<link>` or `<a>` with `rel="webmention"` in a page, resolved against `base`. */
function fromHtml(html, base) {
  for (const [tag] of html.matchAll(/<(?:link|a)\b[^>]*>/gi)) {
    const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1];
    if (attr("rel")?.split(/\s+/).includes("webmention") && attr("href") !== undefined) {
      return new URL(attr("href").replace(/&amp;/g, "&"), base).href;
    }
  }
  return null;
}

/**
 * Where to send a mention for `target` (§15.2): the target origin's manifest
 * webmention key, resolved against the manifest; else W3C discovery on the
 * target — a Link header, then the page's own markup. null when there is
 * none, which a static blyg conformantly has.
 */
export async function discoverEndpoint(origin, target, fetch = globalThis.fetch) {
  try {
    const manifest = await get(fetch, `${origin}blyg.json`);
    const key = parseJson(manifest.text)?.webmention;
    if (typeof key === "string" && key) return new URL(key, manifest.url).href;
  } catch {
    // No manifest is no endpoint from it; W3C discovery may still find one.
  }
  try {
    const page = await get(fetch, target);
    return fromLinkHeader(page.link, page.url) ?? fromHtml(page.text, page.url);
  } catch {
    return null;
  }
}

/**
 * Whether the deployed page at `source` already says what the mention claims:
 * its item document carries this stub_of, or for a withdrawal is the endcap.
 * Read the way the receiver will read it (§15.4), from the live site.
 */
async function deployed(source, origin, entry, phase, fetch) {
  try {
    const { fetched, doc } = await itemDocument(source, fetch);
    if (fetched.url !== `${origin}items/${entry.id}.json` || doc.id !== entry.id) return false;
    if (phase === "withdrawal") return doc.kind === "withdrawn";
    return doc.stub_of?.id === entry.stub_of.id
      && normalizeOrigin(doc.stub_of.origin) === normalizeOrigin(entry.stub_of.origin);
  } catch {
    return false;
  }
}

/**
 * What a stub's record should be working towards this run, or null for
 * nothing to do: a first send, a re-send because the reference changed, or the
 * one re-send a withdrawal owes a stub that was sent (§15.2, §15.7).
 */
function due(entry, record, source, target, now) {
  const phase = entry.withdrawn ? "withdrawal" : "stub";
  const fresh = { phase, source, target, version: entry.stub_of.version, status: "pending", attempts: 0 };
  if (phase === "withdrawal") {
    if (!record) return null;
    if (record.phase === "stub") return record.status === "sent" ? fresh : null;
  } else if (!record || record.phase !== "stub" || record.target !== target
             || record.version !== entry.stub_of.version) {
    return fresh;
  }
  if (TERMINAL.has(record.status)) return null;
  if (record.status === "retry" && Date.parse(record.next_at) > now.getTime()) return null;
  return record;
}

/**
 * One pass over every stub: sends what is due and returns the new state.
 * `changed` says whether it differs from what came in, so a run that did
 * nothing writes nothing. A dry run does all the reading — liveness and
 * discovery — and logs the POST it would make instead of making it.
 */
export async function sendMentions({ registry, state, origin, now = new Date(), fetch = globalThis.fetch,
  dryRun = false, log = console.log }) {
  const next = structuredClone(state);
  let changed = false;
  const save = (slug, record) => {
    if (dryRun) return;
    if (JSON.stringify(next[slug]) !== JSON.stringify(record)) changed = true;
    next[slug] = record;
  };

  for (const [slug, entry] of Object.entries(registry.items).sort(([a], [b]) => a.localeCompare(b))) {
    const reference = entry.stub_of;
    if (!reference || normalizeOrigin(reference.origin) === normalizeOrigin(origin)) continue;
    const source = `${origin}${slug}`;
    const target = reference.cited?.url ?? `${normalizeOrigin(reference.origin)}t/${reference.id}/`;
    const record = due(entry, next[slug], source, target, now);
    if (!record) continue;

    if (!await deployed(source, origin, entry, record.phase, fetch)) {
      log(`mentions: ${slug} is not live with its ${record.phase} yet; will try again`);
      save(slug, { ...record, status: "pending" });
      continue;
    }

    const endpoint = await discoverEndpoint(normalizeOrigin(reference.origin), target, fetch);
    if (!endpoint) {
      log(`mentions: ${slug}: ${target} advertises no webmention endpoint`);
      save(slug, { ...record, status: "unreachable", at: toUtc(now) });
      continue;
    }

    const body = new URLSearchParams({ source, target }).toString();
    if (dryRun) {
      log(`mentions: would send ${record.phase} for ${slug}: POST ${endpoint} ${body}`);
      continue;
    }

    const attempts = record.attempts + 1;
    let code = null;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
      code = response.status;
    } catch (error) {
      log(`mentions: ${slug}: ${endpoint} unreachable: ${error.message}`);
    }

    const base = { ...record, endpoint, attempts, at: toUtc(now) };
    delete base.next_at;
    if (code !== null && code >= 200 && code < 300) {
      log(`mentions: sent ${record.phase} for ${slug} to ${endpoint} (${code})`);
      save(slug, { ...base, status: "sent", code });
    } else if (code === null || code === 429 || code >= 500) {
      const wait = BACKOFF[attempts - 1];
      const retry = wait === undefined
        ? { ...base, status: "abandoned" }
        : { ...base, status: "retry", next_at: toUtc(now.getTime() + wait * 60_000) };
      if (code !== null) retry.code = code;
      log(`mentions: ${slug}: ${code ?? "no answer"}; ${retry.status}${retry.next_at ? ` until ${retry.next_at}` : ""}`);
      save(slug, retry);
    } else {
      log(`mentions: ${slug}: ${endpoint} refused it (${code})`);
      save(slug, { ...base, status: "failed", code });
    }
  }

  return { state: next, changed };
}
