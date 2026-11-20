// The reference model: what the blyg surface must say after a history of
// motes events and Action runs, computed from docs/blyg.md's promises alone.
//
// Deliberately slow, plain and independent: it shares no code with tools/, and
// it never converts HTML. Bodies come from a pool the generator controls, so
// "the content changed" is "the body string changed", and whether a body
// converts is something the pool says, not something worked out here.
// Reusing the build's own helpers would let one mistake pass on both sides.

const utc = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A note's published path: its title's slug, or its file name (README). */
export function pageOf(file, body) {
  const title = body.match(/^<p><strong>([^<]*)<\/strong><\/p>/)?.[1];
  if (!title) return file;
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || file;
}

export class Model {
  constructor() {
    /** file → what is on disk: { body, iso, pin, note, write, convertible } */
    this.disk = new Map();
    /** file → registry: { version, changelog: [{ version, at, note, pinned? }], body, page, withdrawn, seen } */
    this.items = new Map();
    this.writes = 0;
    /** Every page an item has had, in order, for redirects (P17). */
    this.pages = new Map();
  }

  publish(file, page) {
    this.writes += 1;
    this.disk.set(file, { ...page, write: this.writes });
  }

  remove(file) {
    this.disk.delete(file);
  }

  /**
   * One run of the Action at `now`. Returns false when it must refuse (P13):
   * nothing changes then.
   */
  action(now) {
    const leaving = [...this.items].filter(([file, item]) => !item.withdrawn && !this.disk.has(file));
    if (leaving.length > 3) return false;

    for (const [file, page] of [...this.disk].sort(([a], [b]) => a.localeCompare(b))) {
      if (!page.convertible) continue; // P6: nothing registers, nothing is consumed
      const unseen = this.items.get(file)?.seen !== page.write;
      let item = this.items.get(file);
      if (!item) {
        item = { version: 1, changelog: [{ version: 1, at: utc(page.iso), note: null }], body: page.body, withdrawn: false };
        item.generated = page.generated ? { model: page.generated, at: utc(page.iso) } : null; // P20
        this.items.set(file, item);
      } else if (item.body !== page.body || item.withdrawn) {
        const last = item.changelog.at(-1);
        const paged = utc(page.iso);
        item.version += 1;
        item.changelog.push({
          version: item.version,
          at: paged > last.at ? paged : utc(now),
          note: unseen ? page.note ?? null : null, // P9
        });
        item.body = page.body;
        item.withdrawn = false;
        item.generated = page.generated ? { model: page.generated, at: item.changelog.at(-1).at } : null; // P20
      }
      if (page.pin && unseen) item.changelog.at(-1).pinned = true; // P7
      item.seen = page.write;
      item.page = pageOf(file, page.body);
      const history = this.pages.get(file) ?? [];
      if (history.at(-1) !== item.page) history.push(item.page);
      this.pages.set(file, history);
    }

    for (const [file, item] of leaving) {
      item.version += 1;
      item.changelog.push({ version: item.version, at: utc(now), note: null }); // P11
      item.withdrawn = true;
      item.body = "";
      item.generated = null; // P20: an endcap never carries it
    }
    this.published = this.computeFeed();
    return true;
  }

  /** The feed as the last Action wrote it. */
  feed() {
    return this.published ?? [];
  }

  /**
   * The feed's entries (P15): every event, a withdrawn item's last only,
   * newest first, 50 at most. A live note whose page no longer converts has
   * none (P6). Taken when the Action runs, from the pages as they were then.
   */
  computeFeed() {
    const events = [];
    for (const [file, item] of this.items) {
      if (!item.withdrawn && this.disk.get(file)?.convertible === false) continue;
      const shown = item.withdrawn ? item.changelog.slice(-1) : item.changelog;
      for (const event of shown) events.push({ file, version: event.version, at: event.at, note: event.note, withdrawn: item.withdrawn });
    }
    events.sort((a, b) => b.at.localeCompare(a.at) || b.file.localeCompare(a.file) || b.version - a.version);
    return events.slice(0, 50);
  }

  snapshot() {
    return structuredClone({ items: Object.fromEntries(this.items), pages: Object.fromEntries(this.pages) });
  }
}
