import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCollector } from "../src/sources/collector.js";
import { requestBytes } from "../src/sources/http.js";
import { collectSecEdgar } from "../src/sources/sec-edgar.js";
import { collectFinnhub } from "../src/sources/finnhub.js";
import { normalizeArticle } from "../src/normalize.js";
import { openDatabase, insertWindow } from "../src/database.js";
import { CollectionError } from "../src/errors.js";
import type { SourceConfig } from "../src/config.js";

const config: SourceConfig = { enabled: true, symbols: ["AAPL"], tokenEnv: "INTEGRATION_TEST_TOKEN",
  accessVerified: true, englishVerified: true, mappingVerified: true, pageSize: 1, maxPages: 10,
  maxItems: 10, maxBytes: 10000, timeoutMs: 1000 };
const article = { source: "example", providerArticleId: "one", title: "Results", publishedDate: "2026-10-01",
  publicationPrecision: "day" as const, contentKind: "full" as const, content: "Revenue rose." };

test("JSON and binary requests share one byte budget and one paced request path", async () => {
  let time = 0;
  const starts: number[] = [];
  const source = createCollector({ source: "example", config: { ...config, auth: "none", requestIntervalMs: 10, maxBytes: 2 },
    validateProvider() {}, runtime: { now: () => time, sleep: async ms => { time += ms; }, report() {},
      transport: async () => { starts.push(time); return { data: {}, bytes: 1 }; },
      bytesTransport: async () => { starts.push(time); return { data: Buffer.from("x"), bytes: 1, mediaType: "text/plain" }; },
    } }, async ctx => {
      const url = new URL("https://example.invalid");
      await ctx.get(url);
      await ctx.getBytes(url, {}, 10);
      await ctx.get(url);
    });
  await assert.rejects(source({ from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }), e => e instanceof CollectionError && e.code === "TOO_LARGE");
  assert.deepEqual(starts, [10, 20]);
});

test("HTTP Retry-After produces bounded safe retry information without provider body details", async () => {
  const previous = globalThis.fetch;
  try {
    for (const [delay, retryable, milliseconds] of [["2", true, 2000], ["120", false, 60000]] as const) {
      globalThis.fetch = async () => new Response("sensitive provider body", { status: 429, headers: { "Retry-After": delay } });
      await assert.rejects(requestBytes(new URL("https://example.invalid"), {}, 1000, 1000), e =>
        e instanceof CollectionError && e.code === "RATE_LIMIT" && e.retryable === retryable
          && e.retryAfterMs === milliseconds && e.message === "RATE_LIMIT");
    }
  } finally { globalThis.fetch = previous; }
});

test("Marketaux HTTP 402 quota errors are safe and non-retryable, with bounded error bodies", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: {
      code: "usage_limit_reached", message: "sensitive provider details" } }), { status: 402 });
    await assert.rejects(requestBytes(new URL("https://example.invalid"), {}, 1000, 1000), e =>
      e instanceof CollectionError && e.code === "RATE_LIMIT" && !e.retryable && e.message === "RATE_LIMIT");
    globalThis.fetch = async () => new Response('{"error":{"code":"other_error"}}', { status: 402 });
    await assert.rejects(requestBytes(new URL("https://example.invalid"), {}, 1000, 1000), e =>
      e instanceof CollectionError && e.code === "INCOMPLETE");
    globalThis.fetch = async () => new Response("x".repeat(16385), { status: 402 });
    await assert.rejects(requestBytes(new URL("https://example.invalid"), {}, 1000, 100000), e =>
      e instanceof CollectionError && e.code === "TOO_LARGE");
  } finally { globalThis.fetch = previous; }
});

test("metadata validation rejects invalid and oversized provenance before atomic storage", () => {
  const db = openDatabase(":memory:", true);
  const metadata = { kind: "news_reference" as const, publicationBasis: "provider_timestamp" as const,
    symbols: ["AAPL"], details: { relatedRaw: "AAPL" } };
  try {
    assert.throws(() => normalizeArticle({ ...article, metadata: { ...metadata, details: { invalid: Infinity } } }));
    assert.throws(() => insertWindow(db, [{ ...article, metadata: { ...metadata, details: { tooLong: "x".repeat(65536) } } }],
      "2026-10-19T00:00:00Z", { source: "example", day: "2026-10-01", scopeKey: "scope" }));
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM collection_coverage").get()!.n, 0);
  } finally { db.close(); }
});

test("coverage-only schema upgrades retain prior coverage and immutable article fingerprints", () => {
  const directory = mkdtempSync(join(tmpdir(), "inquisitor-metadata-migration-"));
  try {
    const path = join(directory, "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(readFileSync(new URL("../sql/001_articles.sql", import.meta.url), "utf8"));
    old.exec(readFileSync(new URL("../sql/002_collection_coverage.sql", import.meta.url), "utf8"));
    old.exec("INSERT INTO collection_coverage VALUES ('example','2026-10-01','scope','2026-10-19T00:00:00Z')");
    old.close();
    const db = openDatabase(path);
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM collection_coverage").get()!.n, 1);
      assert.ok(db.prepare("PRAGMA table_info(articles)").all().some(c => c.name === "source_metadata_json"));
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("SEC and Finnhub public wrappers load their own configuration without a live API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inquisitor-new-wrappers-"));
  const previousConfig = process.env.INQUISITOR_CONFIG, previousToken = process.env.INTEGRATION_TEST_TOKEN;
  const previousAgent = process.env.INTEGRATION_SEC_AGENT, previousFetch = globalThis.fetch, previousLog = console.log;
  try {
    const today = new Date();
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3));
    const to = new Date(from.getTime() + 86400000);
    const path = join(directory, "sources.json");
    writeFileSync(path, JSON.stringify({ benzinga: { enabled: false },
      finnhub: { ...config, historyFrom: new Date(from.getTime() - 86400000).toISOString() },
      sec_edgar: { ...config, auth: "none", ciks: { AAPL: "320193" }, userAgentEnv: "INTEGRATION_SEC_AGENT" } }));
    process.env.INQUISITOR_CONFIG = path;
    process.env.INTEGRATION_TEST_TOKEN = "synthetic-integration-token";
    process.env.INTEGRATION_SEC_AGENT = "InquisitorTests tests@example.invalid";
    console.log = () => {};
    const requests: URL[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      const headers = new Headers(init?.headers);
      if (url.host === "finnhub.io") {
        assert.equal(headers.get("X-Finnhub-Token"), "synthetic-integration-token");
        return new Response("[]");
      }
      assert.equal(url.host, "data.sec.gov");
      assert.equal(headers.get("User-Agent"), "InquisitorTests tests@example.invalid");
      assert.equal(headers.get("Authorization"), null);
      return new Response(JSON.stringify({ name: "Issuer", cik: "320193", filings: { recent: {
        accessionNumber: [], filingDate: [], form: [], primaryDocument: [] }, files: [] } }));
    };
    const range = { from: from.toISOString(), to: to.toISOString() };
    assert.deepEqual(await collectFinnhub(range), []);
    assert.deepEqual(await collectSecEdgar(range), []);
    assert.equal(requests.length, 2);
  } finally {
    console.log = previousLog;
    globalThis.fetch = previousFetch;
    for (const [key, value] of [["INQUISITOR_CONFIG", previousConfig], ["INTEGRATION_TEST_TOKEN", previousToken],
      ["INTEGRATION_SEC_AGENT", previousAgent]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
