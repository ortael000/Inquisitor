import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollector, type SourceDiagnostic } from "../src/sources/collector.js";
import { selectContent } from "../src/sources/content.js";
import { PageGuard } from "../src/sources/pagination.js";
import { Budget } from "../src/sources/http.js";
import { benzingaCollector, collectBenzinga } from "../src/sources/benzinga.js";
import { marketauxCollector, collectMarketaux } from "../src/sources/marketaux.js";
import { CollectionError } from "../src/errors.js";
import type { SourceConfig } from "../src/config.js";
import type { NormalizedArticle } from "../src/types.js";
import { sequenceRuntime } from "./helpers/source-fixtures.js";

const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };
const config: SourceConfig = {
  enabled: true, symbols: ["AAPL"], tokenEnv: "COLLECTOR_TEST_TOKEN",
  accessVerified: true, englishVerified: true, mappingVerified: true,
  pageSize: 2, maxPages: 3, maxItems: 4, maxBytes: 10000, timeoutMs: 500,
};
process.env.COLLECTOR_TEST_TOKEN = "synthetic-private-token";
const article: NormalizedArticle = {
  source: "example", providerArticleId: "one", title: "Results", content: "Revenue rose 5%.",
  contentKind: "full", publishedDate: "2026-10-01", publicationPrecision: "day",
};
const url = new URL("https://example.invalid?token=synthetic-private-token");
const options = { source: "example", config, validateProvider() {} };
const hasCode = (code: string) => (error: unknown) => error instanceof CollectionError && error.code === code;

test("acceptance counts invalid and excluded records separately; every invocation starts fresh", async () => {
  const events: SourceDiagnostic[] = [];
  const source = createCollector({ ...options, runtime: { report: e => events.push(e) } }, async ctx => {
    ctx.accept(() => article);
    ctx.accept(() => ({ ...article, title: "" }));
    ctx.accept(() => ({ ...article, publishedDate: "2026-10-03" }));
  });
  for (let call = 0; call < 2; call++) assert.equal((await source(range)).length, 1);
  assert.deepEqual(events[1], { ...range, source: "example", diagnostic: "normalization", status: "completed",
    accepted: 1, rejectedInvalid: 1, excludedRange: 1 });
  assert.deepEqual(events[3], events[1]);
});

test("only VALIDATION is an item rejection; operational and unexpected errors abort safely", async () => {
  for (const error of [new CollectionError("INCOMPLETE"), new CollectionError("AUTHENTICATION"),
    new CollectionError("TRANSPORT", true), new Error("synthetic-private-token provider prose")]) {
    const events: SourceDiagnostic[] = [];
    const source = createCollector({ ...options, runtime: { report: e => events.push(e) } }, async ctx => {
      ctx.accept(() => article);
      ctx.accept(() => { throw error; });
    });
    await assert.rejects(source(range), e => e === error);
    assert.equal(events.at(-1)?.diagnostic, "normalization");
    assert.equal((events.at(-1) as { status: string }).status, "failed");
    assert.doesNotMatch(JSON.stringify(events), /synthetic-private-token|provider prose|example\.invalid|Revenue/);
  }
  await assert.rejects(createCollector({ ...options, runtime: { report() {} } }, async ctx => {
    ctx.accept(() => ({ ...article, source: "wrong" }));
  })(range), hasCode("INCOMPLETE"));
});

test("empty enumeration and all-invalid enumeration are completed with distinct counts", async () => {
  for (const invalid of [false, true]) {
    const events: SourceDiagnostic[] = [];
    const source = createCollector({ ...options, runtime: { report: e => events.push(e) } }, async ctx => {
      if (invalid) ctx.accept(() => ({ ...article, content: "" }));
    });
    assert.deepEqual(await source(range), []);
    assert.equal((events.at(-1) as { status: string }).status, "completed");
    assert.equal((events.at(-1) as { rejectedInvalid: number }).rejectedInvalid, Number(invalid));
  }
});

test("content selection preserves kind and falls back to usable provider text", () => {
  assert.deepEqual(selectContent("Results", [{ value: "Results", kind: "full" },
    { value: "<p>EPS $2.</p>", kind: "summary" }]), { content: "EPS $2.", contentKind: "summary" });
  assert.throws(() => selectContent("Results", [{ value: "Subscribe", kind: "summary" }]), hasCode("VALIDATION"));
});

test("page guards detect repeated pages and cap requests without confusing independent streams", () => {
  const first = new PageGuard(2), second = new PageGuard(2);
  first.next(); first.check([1]);
  second.next(); second.check([1]);
  first.next(); first.check([]);
  assert.throws(() => first.next(), hasCode("TOO_LARGE"));
  assert.throws(() => second.check([1]), hasCode("INCOMPLETE"));
});

test("pacing spaces request starts, accounts for long requests, and resets on each invocation", async () => {
  for (const interval of [0, 10]) {
    let time = 0;
    const starts: number[] = [], sleeps: number[] = [];
    const source = createCollector({ ...options, config: { ...config, requestIntervalMs: interval }, runtime: {
      now: () => time,
      sleep: async ms => { sleeps.push(ms); time += ms; },
      transport: async () => { starts.push(time); if (starts.length === 2) time += 30; return { data: {}, bytes: 1 }; },
      report() {},
    } }, async ctx => { await ctx.get(url); await ctx.get(url); await ctx.get(url); });
    await source(range);
    await source(range);
    assert.deepEqual(starts, interval === 0 ? [0, 0, 30, 30, 30, 30] : [10, 20, 50, 60, 70, 80]);
    assert.ok(sleeps.every(ms => ms > 0));
  }
});

test("byte exhaustion fails before another request; rejected raw candidates still use the invocation budget", async () => {
  let calls = 0;
  const budget = new Budget({ ...config, maxBytes: 1 }, async () => { calls++; return { data: {}, bytes: 1 }; });
  await budget.get(url, {});
  await assert.rejects(budget.get(url, {}), hasCode("TOO_LARGE"));
  assert.equal(calls, 1);
  const runtime = sequenceRuntime([[null], [], [null]]);
  await assert.rejects(benzingaCollector({ ...config, symbols: ["AAPL", "MSFT"], maxItems: 1 }, runtime)(range),
    hasCode("TOO_LARGE"));
  runtime.assertDone();
});

test("duplicate IDs across ticker streams remain in output; all-invalid pages keep paging", async () => {
  const raw = { id: "same", title: "Results", body: "Revenue rose.", created: "2026-10-01" };
  const runtime = sequenceRuntime([[null], [raw], [], [raw], []]);
  const result = await benzingaCollector({ ...config, symbols: ["AAPL", "MSFT"] }, runtime)(range);
  assert.equal(result.length, 2);
  assert.equal(result[0].providerArticleId, result[1].providerArticleId);
  runtime.assertDone();
});

test("Marketaux default pacing and body error classification remain provider-specific", async () => {
  let time = 0;
  const source = marketauxCollector(config, { now: () => time, sleep: async ms => { time += ms; }, report() {},
    transport: async () => { assert.equal(time, 2200); return { data: { error: { code: "usage_limit_reached" } }, bytes: 1 }; },
  });
  await assert.rejects(source(range), e => e instanceof CollectionError && e.code === "RATE_LIMIT" && !e.retryable);
});

test("public wrappers load source configuration and credentials internally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inquisitor-wrappers-"));
  const previousConfig = process.env.INQUISITOR_CONFIG;
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const events: string[] = [];
  try {
    const path = join(dir, "sources.json");
    const settings = { ...config, requestIntervalMs: 0 };
    writeFileSync(path, JSON.stringify({ benzinga: settings, marketaux: settings }));
    process.env.INQUISITOR_CONFIG = path;
    console.log = line => events.push(String(line));
    for (const [source, response] of [
      [collectBenzinga, []],
      [collectMarketaux, { data: [], meta: { page: 1, found: 0, returned: 0, limit: 2 } }],
    ] as const) {
      let requests = 0;
      globalThis.fetch = async input => {
        requests++;
        const request = new URL(String(input));
        assert.ok(request.searchParams.get("token") === "synthetic-private-token"
          || request.searchParams.get("api_token") === "synthetic-private-token");
        return new Response(JSON.stringify(response));
      };
      assert.deepEqual(await source(range), []);
      assert.equal(requests, 1);
    }
    assert.doesNotMatch(events.join("\n"), /synthetic-private-token/);
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    if (previousConfig === undefined) delete process.env.INQUISITOR_CONFIG;
    else process.env.INQUISITOR_CONFIG = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
