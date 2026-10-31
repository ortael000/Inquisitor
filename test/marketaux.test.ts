import { test } from "node:test";
import assert from "node:assert/strict";
import { marketauxCollector } from "../src/sources/marketaux.js";
import { CollectionError } from "../src/errors.js";
import { collect } from "../src/collection.js";
import { openDatabase } from "../src/database.js";
import { sequenceRuntime } from "./helpers/source-fixtures.js";
import type { SourceFunction } from "../src/types.js";
import type { SourceConfig } from "../src/config.js";

const range = { from: "2026-10-16T14:00:00Z", to: "2026-10-16T15:00:00Z" };
const item = { uuid: "synthetic-one", title: "Company results", description: "Revenue increased 5%.",
  snippet: "A provider excerpt.", published_at: "2026-10-16T14:30:00.000000Z", language: "en",
  source: "example.invalid", url: "https://example.invalid/news/one" };
const page = (data: unknown[], found = data.length, index = 1, limit = 3) => ({
  meta: { found, returned: data.length, limit, page: index }, data,
});

process.env.MARKETAUX_TEST_TOKEN = "synthetic-test-token";
async function fixture(responses: unknown[], run: (collectSource: SourceFunction, requests: URL[]) => Promise<void>, settings = {}) {
  const config: SourceConfig = { enabled: true, symbols: ["AAPL"], tokenEnv: "MARKETAUX_TEST_TOKEN",
    accessVerified: true, englishVerified: true, mappingVerified: true, pageSize: 3,
    maxPages: 10, maxItems: 30, maxBytes: 100000, timeoutMs: 1000, requestIntervalMs: 0, ...settings };
  const requests: URL[] = [];
  await run(marketauxCollector(config, sequenceRuntime(responses, requests)), requests);
}
test("Marketaux factory paginates and maps provider summaries", async () => {
  const first = [item, { ...item, uuid: "two", description: item.title }, { ...item, uuid: "three", description: "" }];
  await fixture([page(first, 4), page([{ ...item, uuid: "four" }], 4, 2)], async (collectSource, requests) => {
    const result = await collectSource(range);
    assert.equal(result.length, 4);
    assert.equal(result[0].contentKind, "summary");
    assert.equal(result[0].author, undefined);
    assert.equal(result[0].originalPublisher, "example.invalid");
    assert.equal(result[0].providerArticleId, item.uuid);
    assert.equal(result[0].publishedAtUtc, "2026-10-16T14:30:00.000Z");
    assert.equal(result[0].publicationSourceText, item.published_at);
    assert.equal(result[1].content, item.snippet);
    assert.deepEqual(requests.map(url => url.searchParams.get("page")), ["1", "2"]);
    assert.equal(requests[0].searchParams.get("symbols"), "AAPL");
    assert.equal(requests[0].searchParams.get("language"), "en");
    assert.equal(requests[0].searchParams.get("group_similar"), "false");
    assert.equal(requests[0].searchParams.get("limit"), "3");
    assert.equal(requests[0].searchParams.get("published_after"), "2026-10-16T13:59:59");
    assert.equal(requests[0].searchParams.get("published_before"), "2026-10-16T15:00:01");
  });
});

test("Marketaux locally applies half-open boundaries, validates content/language/days and shards symbols", async () => {
  const candidates = [
    { ...item, published_at: range.from }, { ...item, uuid: "end", published_at: range.to },
    { ...item, uuid: "invalid", published_at: "2026-02-30T14:00:00Z" },
    { ...item, uuid: "fr", language: "fr" }, { ...item, uuid: "blank", description: "", snippet: "" },
    { ...item, uuid: "precision", published_at: "2026-10-16T14:30:00.123456Z" },
  ];
  await fixture([page(candidates, 6, 1, 6), page([])], async (collectSource, requests) => {
    const result = await collectSource(range);
    assert.equal(result.length, 1);
    assert.equal(result[0].publishedAtUtc, "2026-10-16T14:00:00.000Z");
    assert.deepEqual(requests.map(url => url.searchParams.get("symbols")), ["AAPL", "MSFT"]);
  }, { symbols: ["AAPL", "MSFT"], pageSize: 6 });
});

test("Marketaux empty completion differs from incomplete/malformed enumeration and transport failure", async () => {
  await fixture([page([])], async collectSource => assert.deepEqual(await collectSource(range), []));
  for (const responses of [
    [page([item], 4)], // A short page must not hide remaining results.
    [page([item], 2, 2)],
    [{ meta: { found: 1, returned: 2, page: 1, limit: 3 }, data: [item] }],
    [{ meta: { found: false, returned: 0, page: 1, limit: 3 }, data: [] }],
    [{ data: [] }],
    [page([item, item, item], 6), page([item, item, item], 6, 2)],
    [page([item, item, item], 6), new CollectionError("TRANSPORT", true)],
    [page([item, item, item], 6), page([item], 7, 2)],
    [page([item, item, item], 6), page([item, item], 6, 2, 2)],
  ]) {
    await fixture(responses, async collectSource => assert.rejects(collectSource(range), CollectionError));
  }
});

test("Marketaux rejects caps, empty symbols and invalid credentials without exposing provider errors", async () => {
  for (const [settings, responses] of [
    [{ maxPages: 1 }, [page([item, item, item], 4)]],
    [{ maxItems: 2 }, [page([item], 3)]],
    [{ maxBytes: 10 }, [page([item])]],
    [{ symbols: [] }, []],
    [{}, [page([], 20001)]],
  ] as [Record<string, unknown>, unknown[]][]) {
    await fixture(responses, async collectSource => assert.rejects(collectSource(range), CollectionError), settings);
  }
  await fixture([new CollectionError("AUTHENTICATION")], async collectSource => {
    await assert.rejects(collectSource(range), (error: unknown) =>
      error instanceof CollectionError && error.code === "AUTHENTICATION" && error.message === "AUTHENTICATION");
  });
});

test("Marketaux ingestion preserves first snapshots and rolls back incomplete windows", async () => {
  const db = openDatabase(":memory:", true);
  try {
    await fixture([page([item])], async collectSource => {
      assert.equal((await collect(db, [{ name: "marketaux", enabled: true, collect: collectSource }], range, { report: () => {} })).failed, false);
    });
    const saved = db.prepare("SELECT * FROM articles").get();
    await fixture([page([{ ...item, description: "A changed description." }])], async collectSource => {
      await collect(db, [{ name: "marketaux", enabled: true, collect: collectSource }], range, { report: summary => assert.equal(summary.alreadyStored, 1) });
    });
    assert.deepEqual(db.prepare("SELECT * FROM articles").get(), saved);
    await fixture([page([{ ...item, uuid: "new" }, item, item], 4), new CollectionError("TRANSPORT", true)], async collectSource => {
      const result = await collect(db, [{ name: "marketaux", enabled: true, collect: collectSource }], range, { report: summary => {
        assert.equal(summary.status, "failed");
        assert.equal(summary.fetched, null);
      } });
      assert.equal(result.failed, true);
    });
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get()!.n, 1);
  } finally { db.close(); }
});
