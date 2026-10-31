/**
 * Collects Benzinga news: builds ticker queries, enumerates zero-based pages,
 * and maps original creation times and lossless IDs to full articles or summaries.
 */

import { isLosslessNumber } from "lossless-json";
import { loadConfig, type SourceConfig } from "../config.js";
import { CollectionError } from "../errors.js";
import { plainText, publication } from "../normalize.js";
import type { NormalizedArticle, SourceFunction } from "../types.js";
import { createCollector, type CollectorRuntime } from "./collector.js";
import { selectContent } from "./content.js";
import { record } from "./http.js";
import { PageGuard } from "./pagination.js";

function articleId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (isLosslessNumber(value) && /^\d+$/.test(value.value)) return value.value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new CollectionError("VALIDATION");
}

function mapArticle(raw: unknown): NormalizedArticle {
  const item = record(raw, "VALIDATION");
  const title = plainText(item.title);
  return {
    source: "benzinga", providerArticleId: articleId(item.id), title,
    author: plainText(item.author) || undefined,
    ...publication(item.created), // Never use the later `updated` timestamp.
    ...selectContent(title, [{ value: item.body, kind: "full" }, { value: item.teaser, kind: "summary" }]),
    url: typeof item.url === "string" ? item.url : undefined,
    originalPublisher: plainText(item.publisher) || undefined,
    language: typeof item.language === "string" ? item.language : undefined,
  };
}

const adjacentDay = (time: string, delta: number) =>
  new Date(Date.parse(time) + delta * 86_400_000).toISOString().slice(0, 10);

export function benzingaCollector(config: SourceConfig, runtime?: Partial<CollectorRuntime>): SourceFunction {
  return createCollector({ source: "benzinga", config, runtime, validateProvider() {
    if (config.pageSize > 100) throw new CollectionError("CONFIGURATION");
  } }, async ctx => {
    // One ticker per query avoids ambiguous multi-ticker AND/OR semantics.
    for (const symbol of new Set(config.symbols)) {
      const pages = new PageGuard(Math.min(config.maxPages, 100001));
      for (let page = 0; ; page++) {
        pages.next();
        const url = new URL("https://api.benzinga.com/api/v2/news");
        url.search = new URLSearchParams({ token: ctx.token, tickers: symbol, page: String(page),
          pageSize: String(config.pageSize), displayOutput: "full", sort: "created:asc",
          dateFrom: adjacentDay(ctx.range.from, -1), dateTo: adjacentDay(ctx.range.to, 1) }).toString();
        const items = await ctx.get(url);
        if (!Array.isArray(items) || items.length > config.pageSize) throw new CollectionError("INCOMPLETE");
        ctx.budget.addItems(items.length);
        pages.check(items);
        for (const item of items) ctx.accept(() => mapArticle(item));
        // A short or all-invalid page does not prove completion.
        if (items.length === 0) break;
      }
    }
  });
}

export const collectBenzinga: SourceFunction = range => benzingaCollector(loadConfig().benzinga)(range);
