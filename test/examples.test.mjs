// Written publishing histories through the oracle (oracle.mjs): the ones the
// generator reaches too rarely to rely on, and every shrunk counterexample
// worth keeping. Separate from oracle.test.mjs so the two run side by side.

import { test } from "node:test";
import { runHistory } from "./oracle.mjs";

const pub = (file, variant, extra = {}) => ({ type: "publish", file, variant, pin: false, note: null, keepTime: false, offset: false, ...extra });
const ACTION = { type: "action" };
const DEPLOY = { type: "deploy" };

/**
 * Histories the generator reaches too rarely to rely on, and every shrunk
 * counterexample worth keeping. Each runs on every test run.
 */
const EXAMPLES = {
  "nothing published": [],
  "four withdrawals at once are refused, three go through (P13)": [
    ...["001-ash-eels", "002-teal-larks", "003-rust-crabs", "004-sage-kites", "005-jade-owls"].map((f) => pub(f, 0)),
    ACTION, DEPLOY, { type: "removeMany" }, ACTION, DEPLOY,
    pub("004-sage-kites", 0), ACTION, DEPLOY,
  ],
  "pin, edit, pin again, withdraw, return (P7, P8, P11, P12)": [
    pub("001-ash-eels", 0, { pin: true }), ACTION, DEPLOY,
    pub("001-ash-eels", 1, { note: "second" }), ACTION, { type: "pinThis", file: "001-ash-eels" }, ACTION, DEPLOY,
    { type: "remove", file: "001-ash-eels" }, ACTION, DEPLOY,
    pub("001-ash-eels", 2), ACTION, DEPLOY,
  ],
  "retitle twice, then pin (P10, P17)": [
    pub("002-teal-larks", 2), ACTION, pub("002-teal-larks", 3), ACTION, pub("002-teal-larks", 0, { pin: true }), ACTION, DEPLOY,
  ],
  "a registered note stops converting, then converts again (P6)": [
    pub("003-rust-crabs", 0), ACTION, DEPLOY, pub("003-rust-crabs", 4, { pin: true }), ACTION, DEPLOY,
    pub("003-rust-crabs", 1), ACTION, DEPLOY,
  ],
  "a machine-written note, then a human edit, then the machine again (P20)": [
    pub("004-sage-kites", 0, { generated: "claude-haiku-5-5", pin: true }), ACTION, DEPLOY,
    pub("004-sage-kites", 1), ACTION, DEPLOY,
    pub("004-sage-kites", 2, { generated: "claude-sonnet-5-5" }), ACTION, DEPLOY,
    { type: "remove", file: "004-sage-kites" }, ACTION, DEPLOY,
  ],
  // Shrunk from a seed-1348751907 failure: the mark followed the page's meta,
  // not the live version.
  "a machine-written note re-rendered without its meta, body unchanged, is still marked (P20)": [
    pub("004-sage-kites", 1, { generated: "claude-haiku-5-5" }), ACTION, pub("004-sage-kites", 1), ACTION, DEPLOY,
  ],
  "a human note re-rendered with the meta, body unchanged, isn't (P20)": [
    pub("001-ash-eels", 0), ACTION, pub("001-ash-eels", 0, { generated: "claude-haiku-5-5" }), ACTION, DEPLOY,
  ],
  "an edit that keeps the page time is timed by the Action (P4)": [
    pub("005-jade-owls", 0), ACTION, pub("005-jade-owls", 1, { keepTime: true, offset: true }), ACTION, DEPLOY,
  ],
};

for (const [name, ops] of Object.entries(EXAMPLES)) {
  test(`example: ${name}`, () => runHistory(ops));
}
