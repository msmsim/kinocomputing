// Generated publishing histories through the real pipeline and the reference
// model (oracle.mjs). fast-check shrinks any failure to a short history.
//
//   ORACLE_RUNS=200 ORACLE_SEED=1 node --test test/oracle.test.mjs

import { test } from "node:test";
import fc from "fast-check";
import { runHistory, RUNS, SEED, TOOLS } from "./oracle.mjs";
import { opArbitrary } from "./histories.mjs";

test("generated histories agree with the model", () => {
  fc.assert(fc.property(fc.array(opArbitrary, { minLength: 1, maxLength: 24 }), (ops) => runHistory(ops)),
    { numRuns: RUNS, seed: SEED, endOnFailure: !!TOOLS });
});

