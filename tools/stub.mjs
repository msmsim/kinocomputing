// Stubs (Blygger 0.4 §10.6): a Subset share of a blyg item is a response to
// exactly one target, and publishes as a thread carrying stub_of — the §5.9
// reference { origin, id, version } plus a frozen cited label.
//
// Resolution is the only part of the build that touches the network, and it
// runs once per note, at registration (see blyg.mjs updateRegistry): the
// result is kept in the registry, so later builds stay offline and
// reproducible. A target that can't be resolved leaves the note a fragment,
// which is what it was before any of this existed.

const TIMEOUT_MS = 5000;
const MAX_BYTES = 1_000_000;
const EXCERPT_LENGTH = 200;
const ID = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

/**
 * The link a Subset share is about: the one in its trailing
 * `<p class="source">`, which Subset's receiver writes and nothing else does.
 * Only absolute http(s) links count; a share of one of our own notes by path
 * would be a self-stub, which there's no call for.
 */
export function stubTarget(content) {
  const source = content.match(/<p class="source"><a href="([^"]+)"/);
  if (!source) return null;
  const url = source[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * An origin as an identity string: lowercase scheme and host, no default
 * port, and exactly one trailing slash — the forms §15.4 treats as equal.
 */
export function normalizeOrigin(origin) {
  const url = new URL(origin);
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `${url.protocol}//${url.host}${path}`;
}

/** A url with its scheme, host and default port normalised, for exact comparison. */
const normalizeUrl = (href) => new URL(href).href;

export async function get(fetch, url, init = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`not an http(s) url: ${url}`);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json, text/html;q=0.9" },
    ...init,
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error(`${url} is over ${MAX_BYTES} bytes`);
  return { url: response.url || url, type: response.headers.get("content-type") ?? "",
    link: response.headers.get("link") ?? "", text };
}

export const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const looksLikeJson = ({ type, text }) => /json/.test(type) || /^\s*\{/.test(text);

/** The first `<link rel="alternate" type="application/json">`, attribute order aside. */
function alternateJson(html, base) {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1];
    if (attr("rel")?.split(/\s+/).includes("alternate") && attr("type") === "application/json" && attr("href")) {
      return new URL(attr("href").replace(/&amp;/g, "&"), base).href;
    }
  }
  return null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

/** Someone else's HTML as a one-line caption. Unknown entities are left as written. */
function caption(html) {
  const text = html
    .replace(/<\/?(?:a|em|i|strong|b|del|s|strike|code|span)(?:\s[^>]*)?>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH + 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}…`;
}

/**
 * The item document a url names: the url itself when it serves one, else the
 * JSON alternate of the page it serves (§5.8). `first` is the url's own
 * response, `fetched` the document's.
 */
export async function itemDocument(url, fetch = globalThis.fetch) {
  const first = await get(fetch, url);
  let fetched = first;
  if (!looksLikeJson(first)) {
    const alternate = alternateJson(first.text, first.url);
    if (!alternate) throw new Error(`${url} links no item document`);
    fetched = await get(fetch, alternate);
  }
  const doc = parseJson(fetched.text);
  if (!doc?.blyg || typeof doc.id !== "string" || !ID.test(doc.id) || typeof doc.origin !== "string"
      || !Number.isInteger(doc.version)) {
    throw new Error(`${fetched.url} is not a blyg item document`);
  }
  return { first, fetched, doc };
}

const toUtc = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Resolves a link to the blyg item it names, as a §5.9 reference with a
 * cited object frozen now. Throws, with the reason, for anything that isn't
 * verifiably an origin's own live item document — the same test a receiver
 * applies to us (§15.4), so a reference made here is one the target can check:
 *
 * 1. The link is the item document, or a page whose JSON alternate is (§5.8).
 * 2. The document's origin, fetched for its manifest, is where that manifest
 *    actually lives after redirects: the identity origin (§12.2), never the
 *    document's or manifest's say-so alone.
 * 3. The document was fetched from exactly {origin}items/{id}.json, or the
 *    manifest's item template expanded with its id (§6.1) — which is what
 *    rules out mirrors and pinned version files.
 */
export async function resolveStub(url, { fetch = globalThis.fetch, now = new Date() } = {}) {
  const { first, fetched, doc } = await itemDocument(url, fetch);

  const origin = normalizeOrigin(doc.origin);
  const manifestFetch = await get(fetch, `${origin}blyg.json`);
  const manifest = parseJson(manifestFetch.text);
  if (!manifest?.blyg) throw new Error(`${origin}blyg.json is not a blyg manifest`);
  const identity = normalizeOrigin(new URL(".", manifestFetch.url).href);
  if (identity !== origin) {
    throw new Error(`${doc.origin} asserts an origin whose manifest is at ${manifestFetch.url}; identity is ${identity}`);
  }

  const expected = [`${origin}items/${doc.id}.json`];
  if (typeof manifest.item === "string") {
    expected.push(new URL(manifest.item.replaceAll("{id}", doc.id), manifestFetch.url).href);
  }
  if (!expected.map(normalizeUrl).includes(normalizeUrl(fetched.url))) {
    throw new Error(`${fetched.url} is not served from its origin's item path`);
  }

  const page = typeof doc.page === "string" && doc.page
    ? new URL(doc.page, origin).href
    : first === fetched ? null : first.url;
  const author = doc.author?.name ?? manifest.author?.name;
  const excerpt = typeof doc.content_html === "string" ? caption(doc.content_html) : "";

  return {
    origin,
    id: doc.id,
    version: doc.version,
    cited: {
      ...(typeof manifest.title === "string" ? { source: manifest.title } : {}),
      ...(typeof author === "string" ? { author } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(page ? { url: page } : {}),
      retrieved: toUtc(now),
    },
  };
}
