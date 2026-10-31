import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "lossless-json";
import { finnhubCollector } from "../src/sources/finnhub.js";
import { configuredSource } from "../src/coverage.js";
import { collect } from "../src/collection.js";
import { openDatabase } from "../src/database.js";
import { CollectionError } from "../src/errors.js";
import { sequenceRuntime } from "./helpers/source-fixtures.js";
import type { SourceConfig } from "../src/config.js";

const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };
const config: SourceConfig = { enabled: true, symbols: ["AAPL"], tokenEnv: "FINNHUB_TEST_TOKEN",
  accessVerified: true, englishVerified: true, mappingVerified: true, historyFrom: "2025-10-19T00:00:00Z",
  pageSize: 1, maxPages: 10, maxItems: 100, maxBytes: 100000, timeoutMs: 1000 };
process.env.FINNHUB_TEST_TOKEN = "synthetic-finnhub-token";
const today = () => new Date("2026-10-19T10:00:00Z");
const item = { id: 10, datetime: Date.parse("2026-10-01T12:00:00Z") / 1000, headline: "Company results",
  summary: "<p>Revenue rose 5%.</p>", source: "Example Wire", related: "AAPL,MSFT", url: "https://example.invalid?id=10", category: "company" };
const code = (expected: string) => (error: unknown) => error instanceof CollectionError && error.code === expected;

function fixture(responses: unknown[], requests: URL[] = []) {
  return { ...sequenceRuntime(responses, requests), today };
}

test("Finnhub uses only documented date/symbol parameters and token headers; merges association provenance", async () => {
  const requests: URL[] = [];
  const runtime = fixture([[item], [item]], requests);
  const transport = runtime.transport;
  runtime.transport = async (url, headers, ...rest) => {
    assert.equal(headers["X-Finnhub-Token"], "synthetic-finnhub-token");
    return transport(url, headers, ...rest);
  };
  const result = await finnhubCollector({ ...config, symbols: ["AAPL", "MSFT", "AAPL"] }, runtime)(range);
  runtime.assertDone();
  assert.equal(result.length, 1);
  assert.equal(result[0].contentKind, "summary");
  assert.equal(result[0].content, "Revenue rose 5%.");
  assert.equal(result[0].publicationPrecision, "second");
  assert.equal(result[0].publishedAtUtc, "2026-10-01T12:00:00.000Z");
  assert.equal(result[0].language, undefined);
  assert.equal(result[0].author, undefined);
  assert.equal(result[0].url, item.url);
  assert.deepEqual(result[0].metadata?.symbols, ["AAPL", "MSFT"]);
  assert.equal(result[0].metadata?.details.providerCompleteness, "unknown");
  assert.equal(result[0].metadata?.details.relatedRaw, item.related);
  assert.deepEqual([...requests[0].searchParams.keys()].sort(), ["from", "symbol", "to"]);
  assert.equal(requests[0].searchParams.get("from"), "2026-09-30");
  assert.equal(requests[0].searchParams.get("to"), "2026-10-02");
});

test("Finnhub filters exact boundaries, preserves large IDs, and counts unusable summaries", async () => {
  const huge = (parse('{"id":9007199254740993123}') as { id: unknown }).id;
  const events: unknown[] = [];
  const runtime = { ...fixture([[{ ...item, id: huge }, { ...item, id: 11, datetime: Date.parse(range.to) / 1000 },
    { ...item, id: 12, summary: "" }, { ...item, id: 13, summary: item.headline }, { ...item, id: null },
    { ...item, id: 14, datetime: "not-a-date" }]]), report: (e: unknown) => events.push(e) };
  const result = await finnhubCollector(config, runtime)(range);
  assert.equal(result.length, 1);
  assert.equal(result[0].providerArticleId, "9007199254740993123");
  assert.match(JSON.stringify(events), /"missingSummary":2/);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-finnhub-token|Revenue/);
});

test("Finnhub errors, undocumented envelopes, candidate caps, missing history, and stale ranges fail", async () => {
  for (const response of [{ error: "private error" }, "<html>denied</html>", null]) {
    await assert.rejects(finnhubCollector(config, fixture([response]))(range), code("INCOMPLETE"));
  }
  for (const error of [new CollectionError("AUTHENTICATION"), new CollectionError("ENTITLEMENT"), new CollectionError("RATE_LIMIT", true)]) {
    await assert.rejects(finnhubCollector(config, fixture([error]))(range), e => e === error);
  }
  await assert.rejects(finnhubCollector({ ...config, maxItems: 1 }, fixture([[item, item]]))(range), code("TOO_LARGE"));
  await assert.rejects(finnhubCollector({ ...config, historyFrom: undefined }, fixture([]))(range), code("CONFIGURATION"));
  await assert.rejects(finnhubCollector({ ...config, requestIntervalMs: 100 }, fixture([]))(range), code("CONFIGURATION"));
  await assert.rejects(finnhubCollector(config, fixture([]))({ from: "2025-10-18T00:00:00Z", to: "2025-10-19T00:00:00Z" }), code("UNSUPPORTED_RANGE"));
  const leap = { ...fixture([[]]), today: () => new Date("2024-02-29T12:00:00Z") };
  assert.deepEqual(await finnhubCollector({ ...config, historyFrom: "2023-01-01T00:00:00Z" }, leap)({
    from: "2023-02-28T00:00:00Z", to: "2023-03-01T00:00:00Z" }), []);
});

test("Finnhub positive/empty days use shared coverage; metadata and first snapshots survive force refresh", async () => {
  const db = openDatabase(":memory:", true);
  try {
    for (const initial of [[item], []]) {
      const settings = { ...config, symbols: [initial.length ? "AAPL" : "MSFT"] };
      const runtime = fixture([initial, [{ ...item, summary: "Changed summary." }]]);
      const source = configuredSource("finnhub", settings, c => finnhubCollector(c, runtime));
      const reports: string[] = [];
      const options = { now: today, report: (s: { status: string }) => reports.push(s.status) };
      await collect(db, [source], range, options);
      const before = db.prepare("SELECT * FROM articles WHERE source='finnhub'").get();
      await collect(db, [source], range, options);
      assert.deepEqual(reports, ["completed", "skipped"]);
      if (initial.length) {
        const metadata = JSON.parse(String(before!.source_metadata_json));
        assert.equal(metadata.kind, "news_reference");
        await collect(db, [source], range, { ...options, force: true });
        assert.deepEqual(db.prepare("SELECT * FROM articles WHERE source='finnhub'").get(), before);
      }
    }
  } finally { db.close(); }
});

test("Finnhub one failed symbol aborts the window and leaves coverage absent", async () => {
  const db = openDatabase(":memory:", true);
  try {
    const settings = { ...config, symbols: ["AAPL", "MSFT"] };
    const source = configuredSource("finnhub", settings, c => finnhubCollector(c, fixture([[item], new CollectionError("TRANSPORT", true)])));
    assert.equal((await collect(db, [source], range, { now: today, report() {} })).failed, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM collection_coverage").get()!.n, 0);
  } finally { db.close(); }
});
