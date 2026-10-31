/** Synthetic request sequences and a clock that advances without real waiting. */
import assert from "node:assert/strict";
import type { CollectorRuntime } from "../../src/sources/collector.js";

export function sequenceRuntime(responses: unknown[], requests: URL[] = []) {
  const pending = [...responses];
  let time = 0;
  const runtime: CollectorRuntime = {
    async transport(url) {
      requests.push(new URL(url));
      assert.ok(pending.length, "Unexpected extra request");
      const data = pending.shift();
      if (data instanceof Error) throw data;
      return { data, bytes: Buffer.byteLength(JSON.stringify(data)) };
    },
    now: () => time,
    sleep: async ms => { time += ms; },
    report: () => {},
  };
  return { ...runtime, assertDone: () => assert.equal(pending.length, 0, "Unconsumed fixture responses") };
}
