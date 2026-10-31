/**
 * Coordinates enabled collectors over daily windows. Skips covered past days,
 * retries failures, validates and stores results, and reports per-window status.
 */

import type { DatabaseSync } from "node:sqlite";
import { hasCoverage, insertWindow } from "./database.js";
import { pastFullDay } from "./coverage.js";
import { CollectionError, safeCode } from "./errors.js";
import { dayWindows, inRange, normalizeArticle, validateRange } from "./normalize.js";
import type { NormalizedArticle, PublicationRange, Source } from "./types.js";

export interface WindowSummary {
  source: string;
  from: string;
  to: string;
  status: "completed" | "failed" | "skipped";
  reason?: "already_covered";
  fetched: number | null;
  inserted: number;
  alreadyStored: number;
  rejected: number;
  error?: string;
}

export async function collect(db: DatabaseSync, sources: Source[], range: PublicationRange,
  options: { continueOnError?: boolean; attempts?: number; force?: boolean; now?: () => Date;
    report?: (summary: WindowSummary) => void } = {}) {
  validateRange(range);
  const enabled = sources.filter(source => source.enabled);
  if (!enabled.length) throw new CollectionError("CONFIGURATION");
  const attempts = options.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new CollectionError("CONFIGURATION");
  const report = options.report ?? (summary => console.log(JSON.stringify(summary)));
  const now = options.now ?? (() => new Date());
  let failed = false;
  for (const source of enabled) {
    for (const window of dayWindows(range)) {
      const summary: WindowSummary = { source: source.name, ...window, status: "failed",
        fetched: null, inserted: 0, alreadyStored: 0, rejected: 0 };
      try {
        const day = pastFullDay(window, now());
        const coverage = day && source.coverageKey
          ? { source: source.name, day, scopeKey: source.coverageKey } : undefined;
        if (coverage && !options.force && hasCoverage(db, coverage)) {
          summary.status = "skipped";
          summary.reason = "already_covered";
          report(summary);
          continue;
        }
        let articles: NormalizedArticle[] = [];
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try { articles = await source.collect(window); break; }
          catch (error) {
            if (!(error instanceof CollectionError) || !error.retryable || attempt === attempts) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.max(attempt * 1000, error.retryAfterMs ?? 0)));
          }
        }
        if (!Array.isArray(articles)) throw new CollectionError("INCOMPLETE");
        summary.fetched = articles.length;
        const eligible: NormalizedArticle[] = [];
        for (const input of articles) {
          try {
            const article = normalizeArticle(input);
            if (article.source !== source.name || !inRange(article, window) || !inRange(article, range)) {
              throw new CollectionError("VALIDATION");
            }
            eligible.push(article);
          } catch { summary.rejected++; }
        }
        // Boundary rejects indicate a broken source contract; do not finalize that day.
        const stored = insertWindow(db, eligible, now().toISOString(), summary.rejected ? undefined : coverage);
        summary.inserted = stored.inserted;
        summary.alreadyStored = stored.alreadyStored;
        summary.status = "completed";
      } catch (error) { summary.error = safeCode(error); failed = true; }
      report(summary);
      // A failed source does not prevent independent sources from running.
      if (summary.status === "failed" && !options.continueOnError) break;
    }
  }
  return { failed };
}
