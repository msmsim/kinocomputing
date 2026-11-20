# Kinocomputing as a blyg

kinocomputing.com is a [Blygger](https://blygger.org/) blyg: a static protocol
surface beside the notes, so blyg readers can follow it, quote it and cite pinned
versions of it, and motes can publish to it as a blyg vault.

Target: protocol 0.3, emitted as `"blyg": "0.3"`, `level: 2`, at parity with msn
(`../msn/_docs/blygger.md`), which this port transfuses. Origin:
`https://kinocomputing.com/` — the surface sits at the site root.

## Promises

What a reader of the site can observe after any history of publishes, edits,
pins, change notes and deletions. These are what the oracles in `test/` check;
the implementation is judged against them, not read for them. Each cites the
spec section it comes from (`docs/protocol-v0.3.md` in `blygger-spec`) or
`msn` where it is a parity decision the spec leaves open.

**Surface**

- P1. The origin serves `blyg.json`, `feed.xml`, `items/index.json`, one
  `items/{id}.json` per item ever registered, and `items/{id}/v{n}.json` for
  exactly the pinned versions (§4).
- P2. Every item document, once served, is served forever: through edits,
  withdrawal, return, a retitle, and a note that stops converting (§4, §9).

**Identity and versions**

- P3. Each note source file (`notes/<file>.html`) is one item. Its id is 26
  characters of lowercase Crockford base32 from 128 random bits, assigned once,
  and never changes (§5.1).
- P4. `version` goes up by exactly 1 for each content change, withdrawal and
  return, and for nothing else. Content is the note's `<main>` as markdown; a
  change to the head, the template, the footer, or a motes re-render with the
  same body is not a version. The changelog runs 1..n without gaps (§5.2).
- P5. `content_hash` is `sha256:` + hex SHA-256 of `content_md`. Every URL in
  `content_html` is absolute. `updated` is the last changelog entry's `at`.
  Every protocol time is UTC `…Z` (§4, §5.1, §5.2).
- P6. A note whose body won't convert to markdown gets no id while new. While
  registered it keeps its last good version and document, and its feed entries
  drop out, until it converts again (msn's behaviour: the feed carries only
  content the registry has a version for).

**Pins and change notes** (motes' blyg vault features)

- P7. A page carrying `<meta name="blyg:pin" content="true">` pins the live
  version that page establishes — the new one if its body changed, the current
  one if not (§8 rule 2). The request is honoured once per page write: a later
  version from any other cause is not pinned by a stale request.
- P8. A pin document is written once and its bytes never change. It stays
  through later edits and withdrawal. A withdrawal endcap is never pinned (§8).
- P9. A page carrying `<meta name="blyg:note" content="…">` gives the version
  that page makes that note in the changelog. It is ignored on a first version
  and when the page makes no version, and never reused (§5.2, msn).
- P10. The live page shows version markers only for what is promised forever:
  pinned versions and the live one (§8.4). Each pinned version has a frozen page
  at `/<page>-v<n>` with its pinned content verbatim and a canonical link to the
  live page.

**Withdrawal**

- P11. Deleting a note's source file withdraws it: one endcap version,
  `kind: "withdrawn"`, empty content, `content_hash` of `""`, `page` kept. Its
  URL serves a tombstone page, not a 404. Pins survive (§9).
- P12. A file reappearing at a withdrawn note's name is the item returning: the
  next version, same id (§9).
- P13. More than three withdrawals at once writes nothing and fails, so a bad
  checkout can't withdraw the site (msn).

**Index, feed, discovery**

- P14. `items/index.json` lists every item ever registered, newest `updated`
  first (§6.2).
- P15. The feed has one entry per publish event, newest first, at most 50.
  GUIDs are `blyg:{id}:v{n}`. Every entry carries its item's latest HTML. A
  title is `note — excerpt`, the excerpt alone, or `withdrawn`. A withdrawn
  item has exactly one entry. A pin adds no entry. `<blyg:manifest>` is
  present (§7).
- P16. Note pages link `rel="blyg"` to the origin and `rel="alternate"` to
  their item document; the stream links `rel="blyg"` and the feed (§5.8, §12.1).
- P17. `page` is the note's published path. When a retitle moves it, the old
  path redirects to the new one (§5.8).

**Stubs and mentions** (dormant until something publishes a stub here)

- P18. A new note whose trailing `<p class="source">` links another blyg's
  item — the link resolving, over the network at registration, to that
  origin's own live item document — is a thread carrying `stub_of`. Decided
  once, at registration; a note registered as a fragment stays one, and a
  link that doesn't resolve leaves a fragment (§10.6, msn).
- P19. Stubs of other origins are announced by Webmention after deploy, with
  §15.2's retry schedule, dry-run until switched on (§15, msn).

## How it is built

Two writers, never both at once:

- **The Action** (`.github/workflows/stream.yml`) runs
  `node tools/build-stream.mjs --state` on every push to main that touches the
  notes or the build. It is the only writer of `blyg/`: the registry
  (`blyg/_registry.json`), and the protocol surface beside it, committed back.
  Ids, versions and pins can't be derived from the pages, so they have to live
  in git.
- **Cloudflare** runs `node tools/build-stream.mjs` on every push. It reads
  `blyg/` and never writes it: it copies the surface into `dist/` and renders
  the pages (versions, discovery links, frozen pages, tombstones) from the
  registry.

A publish therefore deploys twice: once as pushed, with the note on the site
and the surface one step behind, then again when the Action's commit lands.
The first deploy can't invent ids — they're random — which is why only the
Action registers.

Nothing under `notes/` is written, by either. msn strips a consumed pin or
change-note request out of the page; here the registry records the hash of the
source file it last registered instead, and a request is read only from a file
it hasn't seen.
