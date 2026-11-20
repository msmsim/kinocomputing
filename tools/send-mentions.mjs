// Sends the Webmentions owed by this blyg's stubs (see mentions.mjs), reading the
// registry the stream build wrote and keeping its own record of what went.
//
//   node tools/send-mentions.mjs [--dry-run] [--wait <seconds>]
//
// --dry-run checks liveness and discovers endpoints, logs each POST it would
// make, and writes nothing. --wait keeps retrying stubs whose page isn't live
// yet, every 30 seconds for up to that long: a run straight after the stream
// build otherwise lands before Cloudflare has deployed what it committed.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sendMentions } from "./mentions.mjs";

const STATE_DIR = "blyg";
const STATE_FILE = join(STATE_DIR, "_mentions.json");
// The blyg's identity origin, as build-stream.mjs publishes it.
const ORIGIN = "https://www.kinocomputing.com/";
const POLL_SECONDS = 30;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const waitAt = args.indexOf("--wait");
const waitSeconds = waitAt === -1 ? 0 : Number(args[waitAt + 1]);

const registry = JSON.parse(await readFile(join(STATE_DIR, "_registry.json"), "utf8"));
const current = await readFile(STATE_FILE, "utf8").catch(() => null);
let state = current ? JSON.parse(current) : {};

const deadline = Date.now() + waitSeconds * 1000;
for (;;) {
  ({ state } = await sendMentions({ registry, state, origin: ORIGIN, dryRun }));
  const waiting = Object.values(state).some((record) => record.status === "pending");
  if (dryRun || !waiting || Date.now() + POLL_SECONDS * 1000 > deadline) break;
  await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
}

const sorted = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)));
const serialized = `${JSON.stringify(sorted, null, 2)}\n`;
if (!dryRun && serialized !== (current ?? "{}\n") && Object.keys(sorted).length) {
  await writeFile(STATE_FILE, serialized);
  console.log(`mentions: wrote ${STATE_FILE}`);
} else {
  console.log("mentions: nothing to record");
}
