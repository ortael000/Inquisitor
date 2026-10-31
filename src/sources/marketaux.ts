/**
 * Collects Marketaux summaries: builds per-symbol queries, checks page metadata
 * and provider errors, and maps excerpts while preserving publication precision.
 */

import { isLosslessNumber } from "lossless-json";
import { loadConfig, type SourceConfig } from "../config.js";
import { CollectionError } from "../errors.js";
import { instant, plainText, publication } from "../normalize.js";
import type { NormalizedArticle, SourceFunction } from "../types.js";
import { createCollector, type CollectorRuntime } from "./collector.js";
import { selectContent } from "./content.js";
import { record } from "./http.js";
import { PageGuard } from "./pagination.js";

function integer(value: unknown): number {
  if (typeof value !== "number" && !isLosslessNumber(value)) throw new CollectionError("INCOMPLETE");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new CollectionError("INCOMPLETE");
  return result;
}

function readPage(raw: unknown, page: number, pageSize: number) {
  const response = record(raw);
  if (response.error) {
    switch (response.error.code) {
      case "invalid_api_token": throw new CollectionError("AUTHENTICATION");
      case "usage_limit_reached": throw new CollectionError("RATE_LIMIT"); // Daily quota may be exhausted.
      case "endpoint_access_restricted": throw new CollectionError("ENTITLEMENT");
      default: throw new CollectionError("INCOMPLETE");
    }
  }
  const meta = record(response.meta);
  const found = integer(meta.found), returned = integer(meta.returned), limit = integer(meta.limit);
  if (!Array.isArray(response.data) || integer(meta.page) !== page || limit < 1 || limit > pageSize
    || returned !== response.data.length || returned > limit) throw new CollectionError("INCOMPLETE");
  return { items: response.data as unknown[], found, returned, limit };
}

function mapArticle(raw: unknown): NormalizedArticle {
  const item = record(raw, "VALIDATION");
  if (typeof item.uuid !== "string" || !item.uuid.trim()
    || typeof item.language !== "string" || !/^en(?:-|$)/i.test(item.language)
    || typeof item.published_at !== "string") throw new CollectionError("VALIDATION");
  const title = plainText(item.title);
  // Remove only extra zero fractional digits, never round a real instant.
  const time = item.published_at.replace(/\.(\d{3})0{1,3}Z$/, ".$1Z");
  return {
    source: "marketaux", providerArticleId: item.uuid, title,
    ...publication(time), publicationSourceText: item.published_at,
    ...selectContent(title, [{ value: item.description, kind: "summary" }, { value: item.snippet, kind: "summary" }]),
    language: item.language, originalPublisher: plainText(item.source) || undefined,
    url: typeof item.url === "string" ? item.url : undefined,
  };
}

export function marketauxCollector(config: SourceConfig, runtime?: Partial<CollectorRuntime>): SourceFunction {
  return createCollector({ source: "marketaux", config, runtime, defaultIntervalMs: 2200, validateProvider() {
    if (config.pageSize > 100) throw new CollectionError("CONFIGURATION");
  } }, async ctx => {
    // Overfetch second-resolution bounds; shared acceptance applies exact [from,to).
    const after = new Date(Math.floor(instant(ctx.range.from) / 1000) * 1000 - 1000).toISOString().slice(0, 19);
    const before = new Date(Math.ceil(instant(ctx.range.to) / 1000) * 1000 + 1000).toISOString().slice(0, 19);
    for (const symbol of new Set(config.symbols)) {
      const pages = new PageGuard(config.maxPages);
      let fetched = 0, expected: number | undefined, pageLimit: number | undefined;
      for (let page = 1; ; page++) {
        pages.next();
        const url = new URL("https://api.marketaux.com/v1/news/all");
        url.search = new URLSearchParams({ api_token: ctx.token, symbols: symbol, language: "en",
          group_similar: "false", filter_entities: "true", published_after: after, published_before: before,
          limit: String(config.pageSize), page: String(page) }).toString();
        const result = readPage(await ctx.get(url), page, config.pageSize);
        if ((expected !== undefined && result.found !== expected)
          || (pageLimit !== undefined && result.limit !== pageLimit)) throw new CollectionError("INCOMPLETE");
        expected = result.found;
        pageLimit = result.limit;
        if (expected > 20000 || expected > config.maxItems) throw new CollectionError("TOO_LARGE");
        ctx.budget.addItems(result.returned);
        fetched += result.returned;
        if (fetched > expected) throw new CollectionError("INCOMPLETE");
        pages.check(result.items);
        for (const item of result.items) ctx.accept(() => mapArticle(item));
        if (fetched === expected) break;
        if (result.returned < result.limit) throw new CollectionError("INCOMPLETE");
        if (page * result.limit >= 20000) throw new CollectionError("TOO_LARGE");
      }
    }
  });
}

export const collectMarketaux: SourceFunction = range => {
  const config = loadConfig().marketaux;
  if (!config) throw new CollectionError("CONFIGURATION");
  return marketauxCollector(config)(range);
};
