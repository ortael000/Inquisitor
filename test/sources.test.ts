import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "lossless-json";
import type { SourceConfig } from "../src/config.js";
import { CollectionError } from "../src/errors.js";
import { benzingaCollector } from "../src/sources/benzinga.js";
import { requestJson, type Transport } from "../src/sources/http.js";
import { collect } from "../src/collection.js";
import { openDatabase } from "../src/database.js";
import { sequenceRuntime as sequence } from "./helpers/source-fixtures.js";

const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };
const config: SourceConfig = { enabled: true, symbols: ["AAPL"], tokenEnv: "INQUISITOR_TEST_TOKEN",
  accessVerified: true, englishVerified: true, mappingVerified: true,
  pageSize: 2, maxPages: 10, maxItems: 20, maxBytes: 100000, timeoutMs: 500 };
// A synthetic sentinel, never an account credential.
process.env.INQUISITOR_TEST_TOKEN = "synthetic-secret";

const bz = { id: "1", created: "Thu, 01 Oct 2026 10:00:00 -0400", updated: "2026-10-18T10:00:00Z",
  title: "Example company results", body: "<p>Revenue rose 5%.</p>", stocks: [{ name: "AAPL" }] };

test("Benzinga: zero-based pages, allowlisted queries, body/summary, original created and lossless ID", async () => {
  const requests: URL[] = [];
  const hugeId = parse('{"id":9007199254740993123}') as { id: unknown };
  const collector = benzingaCollector(config, sequence([
    [{ ...bz, id: hugeId.id }, { ...bz, id: "2", body: "", teaser: "EPS $2.", author: "" }],
    [{ ...bz, id: "bad", created: "2026-02-30" }], [],
  ], requests));
  const result = await collector(range);
  assert.equal(result.length, 2);
  assert.equal(result[0].providerArticleId, "9007199254740993123");
  assert.equal(result[0].publishedAtUtc, "2026-10-01T14:00:00.000Z");
  assert.equal(result[0].publicationSourceText, bz.created);
  assert.equal(result[0].author, undefined);
  assert.equal(result[1].contentKind, "summary");
  assert.deepEqual(requests.map(r => r.searchParams.get("page")), ["0", "1", "2"]);
  assert.equal(requests[0].searchParams.get("tickers"), "AAPL");
  assert.equal(requests[0].searchParams.get("displayOutput"), "full");
  assert.equal(requests[0].searchParams.get("sort"), "created:asc");
  assert.equal(requests[0].searchParams.get("dateFrom"), "2026-09-30");
  assert.equal(requests[0].searchParams.get("dateTo"), "2026-10-03");
  assert.equal(requests[0].searchParams.has("updatedSince"), false);
});

test("Benzinga: ticker shards, day-only items, local publication and English filtering", async () => {
  const requests: URL[] = [];
  const collect = benzingaCollector({ ...config, symbols: ["AAPL", "MSFT"], pageSize: 4 }, sequence([
    [{ ...bz, created: "2026-10-01" }, { ...bz, id: "2", created: range.to },
      { ...bz, id: "3", language: "fr" }, { ...bz, id: "4", title: "" }], [], [],
  ], requests));
  const result = await collect(range);
  assert.equal(result.length, 1);
  assert.equal(result[0].publicationPrecision, "day");
  assert.equal(result[0].publishedAtUtc, undefined);
  assert.deepEqual(requests.map(r => r.searchParams.get("tickers")), ["AAPL", "AAPL", "MSFT"]);
  assert.deepEqual(await benzingaCollector(config, sequence([[{ ...bz, created: "2026-10-01" }], []]))({
    from: "2026-10-01T01:00:00Z", to: range.to,
  }), []);
});

test("Benzinga: complete empty success; missing pages, malformed/repeated pages and caps fail", async () => {
  assert.deepEqual(await benzingaCollector(config, sequence([[]]))(range), []);
  for (const pages of [
    [[bz], new CollectionError("TRANSPORT", true)],
    [[bz], [bz]],
    [{ errors: ["synthetic"] }],
  ]) await assert.rejects(benzingaCollector(config, sequence(pages))(range), CollectionError);
  for (const limits of [{ maxPages: 1 }, { maxItems: 1 }, { maxBytes: 10 }]) {
    await assert.rejects(benzingaCollector({ ...config, ...limits }, sequence([[bz, { ...bz, id: "2" }]]))(range),
      (e: unknown) => e instanceof CollectionError && e.code === "TOO_LARGE");
  }
});

test("Benzinga preserves saved snapshots after changed current bodies", async () => {
  const db = openDatabase(":memory:", true);
  try {
    const first = benzingaCollector(config, sequence([[bz], []]));
    const changed = benzingaCollector(config, sequence([[{ ...bz, body: "New text." }], []]));
    await collect(db, [{ name: "benzinga", enabled: true, collect: first }], range, { report: () => {} });
    const before = db.prepare("SELECT * FROM articles WHERE source=?").get("benzinga");
    await collect(db, [{ name: "benzinga", enabled: true, collect: changed }], range, { report: () => {} });
    assert.ok(before);
    assert.deepEqual(db.prepare("SELECT * FROM articles WHERE source=?").get("benzinga"), before);
  } finally { db.close(); }
});

test("configuration and history gates prevent requests", async () => {
  const noTransport: Transport = async () => { assert.fail("Transport must not be called"); };
  for (const factory of [benzingaCollector]) {
    for (const patch of [{ enabled: false }, { symbols: [] }, { accessVerified: false }, { englishVerified: false },
      { mappingVerified: false }, { pageSize: 101 }, { symbols: ["AAPL OR ALL"] }, { tokenEnv: "MISSING_TEST_TOKEN" },
      { historyFrom: "2026-10-02T00:00:00Z" }]) {
      await assert.rejects(factory({ ...config, ...patch }, { transport: noTransport, report: () => {} })(range), CollectionError);
    }
  }
});

test("HTTP status, timeout, JSON and byte failures expose only safe error codes", async () => {
  const original = globalThis.fetch;
  try {
    const cases: [number, string][] = [[401, "AUTHENTICATION"], [403, "ENTITLEMENT"], [429, "RATE_LIMIT"],
      [500, "TRANSPORT"], [404, "INCOMPLETE"]];
    for (const [status, code] of cases) {
      globalThis.fetch = async () => new Response("synthetic-secret", { status });
      await assert.rejects(requestJson(new URL("https://example.invalid?token=synthetic-secret"), {}, 50, 100),
        (e: unknown) => e instanceof CollectionError && e.message === code && !e.message.includes("secret"));
    }
    globalThis.fetch = async () => { throw new Error("synthetic-secret"); };
    await assert.rejects(requestJson(new URL("https://example.invalid"), {}, 50, 100),
      (e: unknown) => e instanceof CollectionError && e.code === "TRANSPORT" && e.retryable);
    globalThis.fetch = async () => new Response("not json");
    await assert.rejects(requestJson(new URL("https://example.invalid"), {}, 50, 100), CollectionError);
    globalThis.fetch = async () => new Response("x".repeat(20));
    await assert.rejects(requestJson(new URL("https://example.invalid"), {}, 50, 10),
      (e: unknown) => e instanceof CollectionError && e.code === "TOO_LARGE");
    globalThis.fetch = async () => new Response('{"id":9007199254740993123}');
    const result = await requestJson(new URL("https://example.invalid"), {}, 50, 100);
    assert.equal(String((result.data as any).id), "9007199254740993123");
  } finally { globalThis.fetch = original; }
});
