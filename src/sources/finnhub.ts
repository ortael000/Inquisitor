/**
 * Collects Finnhub company-news summaries with header authentication, guarded
 * date queries, exact IDs, publisher provenance, and merged symbol associations.
 */

import { isLosslessNumber } from "lossless-json";
import { loadConfig, type SourceConfig } from "../config.js";
import { CollectionError } from "../errors.js";
import { instant, plainText, publication, usableContent } from "../normalize.js";
import type { NormalizedArticle, SourceFunction } from "../types.js";
import { createCollector, type CollectorRuntime } from "./collector.js";
import { record } from "./http.js";

interface FinnhubRuntime extends Partial<CollectorRuntime> { today?: () => Date }
const dayMs = 86_400_000;

function newsId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (isLosslessNumber(value) && /^\d+$/.test(value.value)) return value.value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new CollectionError("VALIDATION");
}

function mapArticle(raw: unknown, symbols: string[]): NormalizedArticle {
  const item = record(raw, "VALIDATION");
  if (typeof item.datetime !== "number" && !isLosslessNumber(item.datetime)) throw new CollectionError("VALIDATION");
  const seconds = Number(item.datetime);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds * 1000 > 8.64e15) throw new CollectionError("VALIDATION");
  return {
    source: "finnhub", providerArticleId: newsId(item.id), title: plainText(item.headline),
    ...publication(new Date(seconds * 1000).toISOString()), publicationPrecision: "second",
    publicationSourceText: String(item.datetime),
    content: plainText(item.summary), contentKind: "summary",
    originalPublisher: plainText(item.source) || undefined,
    url: typeof item.url === "string" ? item.url : undefined,
    // The response has no language/author fields; operator verification gates English eligibility.
    metadata: { kind: "news_reference", publicationBasis: "provider_timestamp", symbols,
      details: { relatedRaw: typeof item.related === "string" ? item.related : null,
        category: typeof item.category === "string" ? item.category : null,
        associationMethod: "query_symbol", editorialType: "unknown", providerCompleteness: "unknown",
        languageMethod: "operator_verified" } },
  };
}

/** Calendar year with leap-day clamping, rather than an assumed 365-day duration. */
function yearAgo(date: Date): number {
  const year = date.getUTCFullYear() - 1, month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return Date.UTC(year, month, day);
}

export function finnhubCollector(config: SourceConfig, runtime: FinnhubRuntime = {}): SourceFunction {
  return createCollector({ source: "finnhub", config, runtime, defaultIntervalMs: 1334, providerCompleteness: "unknown", validateProvider() {
    if (config.auth === "none" || !config.historyFrom || (config.requestIntervalMs ?? 1334) < 1334) {
      throw new CollectionError("CONFIGURATION");
    }
  } }, async ctx => {
    const cutoff = Math.max(instant(config.historyFrom!), yearAgo((runtime.today ?? (() => new Date()))()));
    if (instant(ctx.range.from) < cutoff) throw new CollectionError("UNSUPPORTED_RANGE");
    const after = new Date(Math.max(cutoff, instant(ctx.range.from) - dayMs)).toISOString().slice(0, 10);
    const before = new Date(Math.min(instant(ctx.range.to) - 1 + dayMs,
      config.historyTo ? instant(config.historyTo) - 1 : Infinity)).toISOString().slice(0, 10);
    const found = new Map<string, { raw: unknown; symbols: Set<string> }>();
    let requests = 0;
    for (const symbol of new Set(config.symbols)) {
      if (++requests > config.maxPages) throw new CollectionError("TOO_LARGE");
      const url = new URL("https://finnhub.io/api/v1/company-news");
      url.search = new URLSearchParams({ symbol, from: after, to: before }).toString();
      const items = await ctx.get(url, { accept: "application/json", "X-Finnhub-Token": ctx.token });
      if (!Array.isArray(items)) throw new CollectionError("INCOMPLETE");
      ctx.budget.addItems(items.length);
      for (const raw of items) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          ctx.accept(() => mapArticle(raw, [symbol])); continue;
        }
        const item = record(raw, "VALIDATION");
        const title = plainText(item.headline), summary = plainText(item.summary);
        if (!usableContent(summary, title)) { ctx.reject("missing_summary"); continue; }
        // Invalid item IDs are handled by acceptance, while duplicate IDs collect all query associations.
        let id: string;
        try { id = newsId(item.id); }
        catch { ctx.accept(() => mapArticle(item, [symbol])); continue; }
        const previous = found.get(id);
        if (previous) previous.symbols.add(symbol);
        else found.set(id, { raw: item, symbols: new Set([symbol]) });
      }
    }
    for (const item of found.values()) ctx.accept(() => mapArticle(item.raw, [...item.symbols].sort()));
  });
}

export const collectFinnhub: SourceFunction = range => {
  const config = loadConfig().finnhub;
  if (!config) throw new CollectionError("CONFIGURATION");
  return finnhubCollector(config)(range);
};
