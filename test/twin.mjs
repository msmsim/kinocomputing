// The publishing pipeline as a twin: a throwaway copy of the site, a motes that
// writes note pages the way the app does, the Action's state step and a
// Cloudflare deploy. Each step runs the real build as a child process, so the
// build is exercised exactly as it ships — nothing here imports it.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

/** What a site needs to build: the tools, the templates, the assets. No notes, no state. */
const SEED = ["tools", "notes/_note.html", "notes/_stream.html", "note.css", "favicon.svg", "kinocomputing-basic-og.jpg"];

export function makeSite({ repo = REPO, tools = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kino-twin-"));
  for (const path of SEED) cpSync(join(repo, path), join(root, path), { recursive: true });
  if (tools) {
    rmSync(join(root, "tools"), { recursive: true, force: true });
    cpSync(tools, join(root, "tools"), { recursive: true });
  }
  mkdirSync(join(root, "blyg"), { recursive: true });
  return new Site(root);
}

const escapeAttr = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export class Site {
  constructor(root) {
    this.root = root;
    this.template = readFileSync(join(root, "notes/_note.html"), "utf8");
  }

  /**
   * Writes notes/<file>.html as motes renders it: the site's own _note.html,
   * filled, with each if-section kept when motes has a value for it and
   * dropped when it doesn't. `pin` and `note` are the blyg vault's two extras.
   */
  publish(file, { body, iso, pin = false, note = null, description = "" }) {
    const values = {
      slug: file,
      description: escapeAttr(description),
      url: `https://kinocomputing.com/notes/${file}`,
      path: `/notes/${file}`,
      index_path: "/notes/",
      datetime_iso: iso,
      datetime: iso,
      content: body,
      ...(pin ? { pin: "true" } : {}),
      ...(note ? { change_note: escapeAttr(note) } : {}),
    };
    const page = this.template
      .replace(/<!-- if:(\w+) -->([\s\S]*?)<!-- \/if:\1 -->\n?/g, (whole, name, inner) =>
        (Object.hasOwn(values, name) ? inner : ""))
      .replace(/\{\{(\w+)\}\}/g, (whole, name) => (Object.hasOwn(values, name) ? values[name] : ""));
    writeFileSync(join(this.root, "notes", `${file}.html`), page);
  }

  remove(file) {
    rmSync(join(this.root, "notes", `${file}.html`), { force: true });
  }

  run(args, env = {}) {
    const result = spawnSync(process.execPath, ["tools/build-stream.mjs", ...args], {
      cwd: this.root, encoding: "utf8", env: { ...process.env, ...env },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  /** The Action's step: registers what changed and writes blyg/. */
  action(now) {
    return this.run(["--state"], { BLYG_NOW: now });
  }

  /** A Cloudflare deploy: a fresh dist/ from what is committed. */
  deploy() {
    rmSync(join(this.root, "dist"), { recursive: true, force: true });
    const result = this.run([]);
    if (result.code !== 0) throw new Error(`deploy failed:\n${result.out}`);
    return readTree(join(this.root, "dist"));
  }

  dispose() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Every file under dir, as path → utf8 text. */
export function readTree(dir) {
  const files = new Map();
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path), readFileSync(path, "utf8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

export const json = (tree, path) => (tree.has(path) ? JSON.parse(tree.get(path)) : null);

export { execFileSync, REPO };
