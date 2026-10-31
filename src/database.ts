/**
 * Manages SQLite article storage. Contains schema verification, database setup
 * and upgrades, daily coverage, and atomic inserts preserving existing snapshots.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CollectionError } from "./errors.js";
import { fingerprints, instant, normalizeArticle } from "./normalize.js";
import type { NormalizedArticle } from "./types.js";

const schema = readFileSync(new URL("../sql/001_articles.sql", import.meta.url), "utf8");
const coverageSchema = readFileSync(new URL("../sql/002_collection_coverage.sql", import.meta.url), "utf8");
const metadataSchema = readFileSync(new URL("../sql/003_source_metadata.sql", import.meta.url), "utf8");
const compact = (sql: string) => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();

export function assertSchema(db: DatabaseSync, allowLegacy = false): void {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(schema);
    const query = "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
    const signature = (database: DatabaseSync) => database.prepare(query).all()
      .map(row => [row.name, compact(String(row.sql))]);
    const actual = JSON.stringify(signature(db));
    if (allowLegacy && actual === JSON.stringify(signature(expected))) return;
    expected.exec(coverageSchema);
    if (allowLegacy && actual === JSON.stringify(signature(expected))) return;
    expected.exec(metadataSchema);
    if (actual !== JSON.stringify(signature(expected))) throw new CollectionError("DATABASE");
  } finally { expected.close(); }
}

export function openDatabase(path: string, initialize = false): DatabaseSync {
  if (!initialize && !existsSync(path)) throw new CollectionError("DATABASE");
  if (initialize && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    db.exec("BEGIN IMMEDIATE");
    try {
      const objects = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (initialize && objects.length === 0) db.exec(schema);
      // Only upgrade the exact supported article-only schema; never infer old coverage.
      assertSchema(db, true);
      if (!db.prepare("SELECT name FROM sqlite_schema WHERE name='collection_coverage'").get()) db.exec(coverageSchema);
      if (!db.prepare("PRAGMA table_info(articles)").all().some(c => c.name === "source_metadata_json")) db.exec(metadataSchema);
      assertSchema(db);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.exec("PRAGMA journal_mode=WAL;");
  } catch (error) { db.close(); throw error; }
  return db;
}

export interface CoverageRecord { source: string; day: string; scopeKey: string }

export function hasCoverage(db: DatabaseSync, coverage: CoverageRecord): boolean {
  return !!db.prepare("SELECT 1 FROM collection_coverage WHERE source=? AND day_utc=? AND scope_key=?")
    .get(coverage.source, coverage.day, coverage.scopeKey);
}

export function insertWindow(db: DatabaseSync, articles: NormalizedArticle[], retrievedAt: string, coverage?: CoverageRecord) {
  instant(retrievedAt);
  const insert = db.prepare(`INSERT INTO articles (
    article_id, source, provider_article_id, title, author, original_publisher, url,
    published_date, published_at_utc, publication_precision, publication_source_text,
    content, content_kind, language, content_fingerprint, text_fingerprint, retrieved_at, source_metadata_json
  ) VALUES (${Array(18).fill("?").join(",")})
    ON CONFLICT(source, provider_article_id) DO NOTHING`);
  const existing = db.prepare("SELECT article_id FROM articles WHERE source=? AND provider_article_id=?");
  let inserted = 0;
  const articleIds: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const input of articles) {
      const a = normalizeArticle(input);
      const fp = fingerprints(a);
      const id = randomUUID();
      const result = insert.run(id, a.source, a.providerArticleId, a.title, a.author ?? null,
        a.originalPublisher ?? null, a.url ?? null, a.publishedDate, a.publishedAtUtc ?? null,
        a.publicationPrecision, a.publicationSourceText ?? null, a.content, a.contentKind,
        a.language ?? null, fp.content, fp.text, retrievedAt, a.metadata ? JSON.stringify(a.metadata) : null);
      inserted += Number(result.changes);
      articleIds.push(String(existing.get(a.source, a.providerArticleId)!.article_id));
    }
    if (coverage) {
      db.prepare(`INSERT INTO collection_coverage (source, day_utc, scope_key, completed_at)
        VALUES (?,?,?,?) ON CONFLICT(source, day_utc, scope_key) DO UPDATE SET completed_at=excluded.completed_at`)
        .run(coverage.source, coverage.day, coverage.scopeKey, retrievedAt);
    }
    db.exec("COMMIT");
    return { inserted, alreadyStored: articles.length - inserted, articleIds };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
