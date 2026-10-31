import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase, insertWindow } from "../src/database.js";
import { collect, type WindowSummary } from "../src/collection.js";
import { CollectionError } from "../src/errors.js";
import { backupDatabase, restoreCheck } from "../src/backup.js";
import { dayWindows, fingerprints, inRange, normalizeArticle, plainText, publication } from "../src/normalize.js";
import type { NormalizedArticle } from "../src/types.js";

const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };
const retrieved = "2026-10-18T10:00:00.000Z";
const article: NormalizedArticle = { source: "synthetic", providerArticleId: "one", title: "Company update",
  publishedDate: "2026-10-01", publicationPrecision: "day", content: "Revenue rose 5%.", contentKind: "full", language: "en" };

test("article and coverage tables, immutable IDs/fingerprints and separate source copies", () => {
  const db = openDatabase(":memory:", true);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()!.n, 2);
    const first = insertWindow(db, [article], retrieved);
    const before = db.prepare("SELECT * FROM articles").get()!;
    const again = insertWindow(db, [{ ...article, title: "Changed", content: "A different current body." }], retrieved);
    assert.equal(first.articleIds[0], again.articleIds[0]);
    assert.equal(again.alreadyStored, 1);
    assert.deepEqual(db.prepare("SELECT * FROM articles").get(), before);
    assert.equal(before.author, null);
    assert.equal(before.published_at_utc, null);
    assert.equal(before.retrieved_at, retrieved);
    assert.match(String(before.article_id), /^[0-9a-f-]{36}$/);
    const columns = Object.keys(before);
    assert.throws(() => db.prepare(`INSERT INTO articles (${columns.join(",")})
      VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map(column => column === "article_id" ? "different-id" : before[column])),
    /UNIQUE constraint failed: articles.source, articles.provider_article_id/);
    const other = insertWindow(db, [{ ...article, source: "other" }], retrieved);
    assert.notEqual(other.articleIds[0], first.articleIds[0]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles WHERE text_fingerprint=?")
      .get(before.text_fingerprint!)!.n, 2);
    // Future analysis tables can reference both stable input identifiers.
    db.exec("CREATE TABLE analysis (article_id TEXT REFERENCES articles(article_id), content_fingerprint TEXT)");
    db.prepare("INSERT INTO analysis VALUES (?,?)").run(before.article_id!, before.content_fingerprint!);
    assert.throws(() => db.prepare("INSERT INTO analysis VALUES (?,?)").run("missing", "hash"));
  } finally { db.close(); }
});

test("validation, summaries and HTML preserve wording and short alerts", () => {
  assert.equal(plainText('<p>Revenue &amp; profit: $2.50.</p><p>CEO: “Up 5%.”</p><script>bad()</script>'),
    'Revenue & profit: $2.50.\n\nCEO: “Up 5%.”');
  assert.equal(normalizeArticle({ ...article, contentKind: "summary", content: "EPS $2." }).contentKind, "summary");
  for (const patch of [
    { title: " " }, { publishedDate: "2026-02-30" }, { publishedDate: "" }, { content: "" },
    { content: article.title }, { content: "Subscribe to continue" }, { publishedAtUtc: retrieved },
    { language: "fr" }, { publicationPrecision: "second", publishedAtUtc: "2026-10-01T10:00:00.123Z" },
  ]) assert.throws(() => normalizeArticle({ ...article, ...patch } as NormalizedArticle));
  assert.notEqual(fingerprints(article).content, fingerprints({ ...article, title: "Other title" }).content);
  assert.equal(fingerprints(article).text, fingerprints({ ...article, title: "Other title" }).text);
});

test("original day, offset, precision and half-open publication bounds", () => {
  const precise = publication("Thu, 01 Oct 2026 23:30:00 -0400");
  assert.equal(precise.publishedDate, "2026-10-01");
  assert.equal(precise.publishedAtUtc, "2026-10-02T03:30:00.000Z");
  assert.equal(precise.publicationPrecision, "second");
  assert.equal(publication("2026-10-01T12:30Z").publicationPrecision, "minute");
  assert.equal(publication("2026-10-01T12Z").publicationPrecision, "hour");
  assert.equal(publication("2026-10-01T12:30:00.100Z").publicationPrecision, "millisecond");
  assert.equal(publication("2026-10-01").publishedAtUtc, undefined);
  for (const value of ["2026-02-30T10:00:00Z", "2026-10-01T12:00:00", "2026-10-01T25:00:00Z",
    "Thu, 30 Feb 2026 10:00:00 -0400"]) assert.throws(() => publication(value));
  assert.equal(inRange(article, range), true);
  assert.equal(inRange(article, { ...range, from: "2026-10-01T01:00:00Z" }), false);
  assert.equal(inRange({ ...article, ...publication(range.from) }, range), true);
  assert.equal(inRange({ ...article, ...publication(range.to) }, range), false);
  assert.equal(inRange({ ...article, ...precise }, range), false);
  assert.equal([...dayWindows({ from: "2026-10-01T12:00:00Z", to: "2026-10-03T02:00:00Z" })].length, 3);
});

test("committed windows survive failure; reruns resume; independent source still runs", async () => {
  const db = openDatabase(":memory:", true);
  const summaries: WindowSummary[] = [];
  const larger = { ...range, to: "2026-10-03T00:00:00Z" };
  let fail = true;
  const sources = [
    { name: "synthetic", enabled: true, collect: async (window: typeof range) => {
      if (window.from.startsWith("2026-10-02")) {
        if (fail) throw new CollectionError("INCOMPLETE");
        return [{ ...article, providerArticleId: "two", publishedDate: "2026-10-02" }];
      }
      return [article, { ...article, providerArticleId: "invalid", title: "" }];
    } },
    { name: "other", enabled: true, collect: async () => [] },
  ];
  try {
    assert.equal((await collect(db, sources, larger, { report: s => summaries.push(s) })).failed, true);
    assert.equal(summaries[0].inserted, 1);
    assert.equal(summaries[0].rejected, 1);
    assert.equal(summaries[1].fetched, null);
    assert.equal(summaries[1].error, "INCOMPLETE");
    assert.equal(summaries[2].source, "other");
    assert.equal(summaries[2].status, "completed");
    assert.equal(summaries[2].fetched, 0);
    fail = false;
    summaries.length = 0;
    assert.equal((await collect(db, sources, larger, { report: s => summaries.push(s) })).failed, false);
    assert.equal(summaries[0].alreadyStored, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get()!.n, 2);
  } finally { db.close(); }
});

test("continue-on-error proceeds to later windows and retries stay bounded", async () => {
  const db = openDatabase(":memory:", true);
  const summaries: WindowSummary[] = [];
  let calls = 0;
  try {
    const result = await collect(db, [{ name: "synthetic", enabled: true, collect: async () => {
      calls++;
      throw new CollectionError("INCOMPLETE");
    } }], { ...range, to: "2026-10-03T00:00:00Z" }, { continueOnError: true, attempts: 3, report: s => summaries.push(s) });
    assert.equal(result.failed, true);
    assert.equal(calls, 2); // Nonretryable errors do not waste attempts.
    assert.equal(summaries.length, 2);
    await assert.rejects(collect(db, [], range));
  } finally { db.close(); }
});

test("window insertion rolls back on a validation failure", () => {
  const db = openDatabase(":memory:", true);
  try {
    assert.throws(() => insertWindow(db, [article, { ...article, title: "" }], retrieved));
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get()!.n, 0);
  } finally { db.close(); }
});

test("setup rejects incompatible schemas; manual backup restores committed WAL data", () => {
  const dir = mkdtempSync(join(tmpdir(), "inquisitor-test-"));
  try {
    const path = join(dir, "articles.sqlite"), backup = join(dir, "backup.sqlite");
    const db = openDatabase(path, true);
    try {
      db.exec("PRAGMA wal_autocheckpoint=0");
      insertWindow(db, [article], retrieved);
      backupDatabase(path, backup);
      assert.equal(restoreCheck(backup), 1);
      assert.throws(() => backupDatabase(path, backup));
    } finally { db.close(); }
    openDatabase(path, true).close();
    const badPath = join(dir, "bad.sqlite"), bad = new DatabaseSync(badPath);
    bad.exec("CREATE TABLE articles (article_id TEXT)");
    bad.close();
    assert.throws(() => openDatabase(badPath, true));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI exits nonzero safely for disabled sources and invalid ranges", () => {
  for (const args of [
    ["collect", "--from", range.from, "--to", range.to],
    ["collect", "--from", "bad", "--to", range.to],
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      encoding: "utf8", env: { ...process.env, INQUISITOR_CONFIG: "config/sources.example.json" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"status":"failed"/);
  }
});

test("CLI reports failed windows and exits nonzero while trying other sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "inquisitor-cli-"));
  try {
    const path = join(dir, "articles.sqlite"), configPath = join(dir, "sources.json");
    openDatabase(path, true).close();
    const source = { enabled: true, accessVerified: true, englishVerified: true, mappingVerified: true,
      symbols: ["AAPL"], tokenEnv: "INQUISITOR_ABSENT_TEST_TOKEN", pageSize: 1,
      maxPages: 2, maxBytes: 1000, maxItems: 10, timeoutMs: 100 };
    writeFileSync(configPath, JSON.stringify({ benzinga: source, marketaux: source }));
    const env: NodeJS.ProcessEnv = { ...process.env, INQUISITOR_CONFIG: configPath };
    delete env.INQUISITOR_ABSENT_TEST_TOKEN;
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "collect",
      "--db", path, "--from", range.from, "--to", range.to], { encoding: "utf8", env });
    assert.equal(result.status, 1);
    const summaries = result.stdout.trim().split("\n").map(line => JSON.parse(line))
      .filter(row => !row.diagnostic);
    assert.equal(summaries.length, 2);
    assert.ok(summaries.every(s => s.status === "failed" && s.error === "AUTHENTICATION" && s.fetched === null));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
