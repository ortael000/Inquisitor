import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { configuredSource, pastFullDay } from "../src/coverage.js";
import { collect, type WindowSummary } from "../src/collection.js";
import { openDatabase, insertWindow, hasCoverage } from "../src/database.js";
import { backupDatabase, restoreCheck } from "../src/backup.js";
import { CollectionError } from "../src/errors.js";
import type { SourceConfig } from "../src/config.js";
import type { NormalizedArticle, Source } from "../src/types.js";

const day = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };
const now = () => new Date("2026-10-19T10:00:00Z");
const config: SourceConfig = {
  enabled: true, symbols: ["AAPL"], tokenEnv: "COVERAGE_TEST_TOKEN",
  accessVerified: true, englishVerified: true, mappingVerified: true,
  pageSize: 10, maxPages: 10, maxItems: 100, maxBytes: 100000, timeoutMs: 1000,
};
const article: NormalizedArticle = { source: "example", providerArticleId: "one", title: "Results",
  publishedDate: "2026-10-01", publicationPrecision: "day", content: "Revenue rose.", contentKind: "full" };
const coverage = { source: "example", day: "2026-10-01", scopeKey: "selection" };
const quiet = { now, report() {} };

test("covered past days with articles or zero articles skip the source after reopening the database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inquisitor-coverage-"));
  try {
    for (const articles of [[], [article]]) {
      const path = join(directory, `articles-${articles.length}.sqlite`);
      let calls = 0;
      const source: Source = { name: "example", enabled: true, coverageKey: "selection",
        collect: async () => { calls++; return articles; } };
      let db = openDatabase(path, true);
      try {
        assert.equal((await collect(db, [source], day, quiet)).failed, false);
        assert.ok(hasCoverage(db, coverage));
      } finally { db.close(); }
      db = openDatabase(path);
      try {
        const summaries: WindowSummary[] = [];
        await collect(db, [source], day, { now, report: row => summaries.push(row) });
        assert.equal(calls, 1);
        assert.equal(summaries[0].status, "skipped");
        assert.equal(summaries[0].reason, "already_covered");
        assert.equal(summaries[0].fetched, null);
        assert.equal(summaries[0].inserted, 0);
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("only completed UTC full days qualify; current, future, and partial days always fetch", async () => {
  assert.equal(pastFullDay({ from: "2026-10-01T02:00:00+02:00", to: "2026-10-02T02:00:00+02:00" }, now()), "2026-10-01");
  assert.equal(pastFullDay({ from: "2026-10-18T00:00:00Z", to: "2026-10-19T00:00:00Z" }, now()), "2026-10-18");
  const db = openDatabase(":memory:", true);
  let calls = 0;
  const source: Source = { name: "example", enabled: true, coverageKey: "selection", collect: async () => { calls++; return []; } };
  try {
    for (const range of [
      { from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" },
      { from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" },
      { from: "2026-10-01T01:00:00Z", to: day.to },
      { from: day.from, to: "2026-10-01T23:00:00Z" },
    ]) {
      assert.equal(pastFullDay(range, now()), undefined);
      await collect(db, [source], range, quiet);
      await collect(db, [source], range, quiet);
    }
    assert.equal(calls, 8);
    assert.equal(db.prepare("SELECT count(*) AS n FROM collection_coverage").get()!.n, 0);
  } finally { db.close(); }
});

test("source identity, symbols and adapter version isolate coverage; operational settings do not", async () => {
  const db = openDatabase(":memory:", true);
  let calls = 0;
  const factory = () => async () => { calls++; return []; };
  try {
    const source = configuredSource("example", config, factory);
    await collect(db, [source], day, quiet);
    const equivalent = configuredSource("example", { ...config, symbols: ["AAPL", "AAPL"],
      tokenEnv: "ANOTHER_TOKEN", pageSize: 20, maxPages: 20, timeoutMs: 2000, requestIntervalMs: 200 }, factory);
    assert.equal(equivalent.coverageKey, source.coverageKey);
    await collect(db, [equivalent], day, quiet);
    assert.equal(calls, 1);
    await collect(db, [configuredSource("other", config, factory)], day, quiet);
    await collect(db, [configuredSource("example", { ...config, symbols: ["MSFT"] }, factory)], day, quiet);
    await collect(db, [configuredSource("example", config, factory, 2)], day, quiet);
    assert.equal(calls, 4);
    assert.equal(configuredSource("example", { ...config, symbols: ["AAPL", "MSFT"] }, factory).coverageKey,
      configuredSource("example", { ...config, symbols: ["MSFT", "AAPL"] }, factory).coverageKey);
    const mutable = { ...config, symbols: ["AAPL"] };
    const bound = configuredSource("snapshot", mutable, settings => async () => {
      assert.deepEqual(settings.symbols, ["AAPL"]); return [];
    });
    mutable.symbols.push("MSFT");
    await bound.collect(day);
  } finally { db.close(); }
});

test("failure or boundary rejects leave the day uncovered; valid stored articles alone prove no coverage", async () => {
  const db = openDatabase(":memory:", true);
  const source: Source = { name: "example", enabled: true, coverageKey: "selection",
    collect: async () => { throw new CollectionError("INCOMPLETE"); } };
  try {
    assert.equal((await collect(db, [source], day, quiet)).failed, true);
    assert.equal(hasCoverage(db, coverage), false);
    source.collect = async () => [article, { ...article, title: "" }];
    await collect(db, [source], day, quiet);
    assert.equal(hasCoverage(db, coverage), false);
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get()!.n, 1);
    source.collect = async () => [article];
    const summaries: WindowSummary[] = [];
    await collect(db, [source], day, { now, report: row => summaries.push(row) });
    assert.equal(summaries[0].alreadyStored, 1);
    assert.equal(hasCoverage(db, coverage), true);
  } finally { db.close(); }
});

test("articles and coverage commit or roll back together, including empty successful windows", () => {
  const db = openDatabase(":memory:", true);
  try {
    db.exec("CREATE TRIGGER fail_coverage BEFORE INSERT ON collection_coverage BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    assert.throws(() => insertWindow(db, [article], now().toISOString(), coverage));
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get()!.n, 0);
    assert.equal(hasCoverage(db, coverage), false);
    db.exec("DROP TRIGGER fail_coverage");
    assert.throws(() => insertWindow(db, [article, { ...article, title: "" }], now().toISOString(), coverage));
    assert.equal(hasCoverage(db, coverage), false);
    insertWindow(db, [], now().toISOString(), coverage);
    assert.ok(hasCoverage(db, coverage));
  } finally { db.close(); }
});

test("multi-day reruns fetch only missing days; force fetches covered days without changing first snapshots", async () => {
  const db = openDatabase(":memory:", true);
  const calls: string[] = [];
  const source: Source = { name: "example", enabled: true, coverageKey: "selection", collect: async range => {
    calls.push(range.from); return [{ ...article, providerArticleId: range.from, publishedDate: range.from.slice(0, 10) }];
  } };
  try {
    await collect(db, [source], day, quiet);
    const first = db.prepare("SELECT * FROM articles").get();
    await collect(db, [source], { ...day, to: "2026-10-04T00:00:00Z" }, quiet);
    assert.deepEqual(calls, [day.from, day.to, "2026-10-03T00:00:00.000Z"].map(s => new Date(s).toISOString()));
    await collect(db, [source], day, { ...quiet, force: true });
    assert.equal(calls.length, 4);
    assert.deepEqual(db.prepare("SELECT * FROM articles WHERE provider_article_id=?").get(new Date(day.from).toISOString()), first);
  } finally { db.close(); }
});

test("legacy databases migrate without losing articles or inferring coverage; backups preserve both schema versions", () => {
  const directory = mkdtempSync(join(tmpdir(), "inquisitor-upgrade-"));
  try {
    const path = join(directory, "legacy.sqlite"), backup = join(directory, "legacy-backup.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(readFileSync(new URL("../sql/001_articles.sql", import.meta.url), "utf8"));
    legacy.exec(readFileSync(new URL("../sql/003_source_metadata.sql", import.meta.url), "utf8"));
    insertWindow(legacy, [article], now().toISOString());
    legacy.exec("ALTER TABLE articles DROP COLUMN source_metadata_json");
    const before = legacy.prepare("SELECT * FROM articles").get();
    legacy.close();
    backupDatabase(path, backup);
    assert.equal(restoreCheck(backup), 1);
    const db = openDatabase(path);
    try {
      const upgraded = db.prepare("SELECT * FROM articles").get()!;
      assert.equal(upgraded.source_metadata_json, null);
      delete upgraded.source_metadata_json;
      assert.deepEqual(upgraded, before);
      assert.equal(hasCoverage(db, coverage), false);
      insertWindow(db, [], now().toISOString(), coverage);
      const currentBackup = join(directory, "current-backup.sqlite");
      backupDatabase(path, currentBackup);
      assert.equal(restoreCheck(currentBackup), 1);
      const restored = openDatabase(currentBackup);
      try { assert.ok(hasCoverage(restored, coverage)); } finally { restored.close(); }
    } finally { db.close(); }
    const again = openDatabase(path, true);
    again.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CLI skips registered covered sources before resolving credentials and supports --force", () => {
  const directory = mkdtempSync(join(tmpdir(), "inquisitor-coverage-cli-"));
  try {
    const path = join(directory, "articles.sqlite"), settingsPath = join(directory, "sources.json");
    const settings = { ...config, tokenEnv: "INQUISITOR_ABSENT_COVERAGE_TOKEN" };
    writeFileSync(settingsPath, JSON.stringify({ benzinga: settings, marketaux: settings }));
    const db = openDatabase(path, true);
    try {
      for (const name of ["benzinga", "marketaux"]) {
        const source = configuredSource(name, settings, () => async () => []);
        insertWindow(db, [], now().toISOString(), { source: name, day: "2026-10-01", scopeKey: source.coverageKey! });
      }
    } finally { db.close(); }
    const env: NodeJS.ProcessEnv = { ...process.env, INQUISITOR_CONFIG: settingsPath };
    delete env.INQUISITOR_ABSENT_COVERAGE_TOKEN;
    const args = ["--import", "tsx", "src/cli.ts", "collect", "--db", path, "--from", day.from, "--to", day.to];
    const result = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const summaries = result.stdout.trim().split("\n").map(row => JSON.parse(row));
    assert.equal(summaries.length, 2);
    assert.ok(summaries.every(row => row.status === "skipped" && row.reason === "already_covered"));
    const forced = spawnSync(process.execPath, [...args, "--force"], { env, encoding: "utf8" });
    assert.equal(forced.status, 1);
    assert.match(forced.stdout, /AUTHENTICATION/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
