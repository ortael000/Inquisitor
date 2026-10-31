/**
 * Supplies shared article normalization utilities: HTML-to-text conversion,
 * publication-time parsing, range validation and filtering, and snapshot fingerprints.
 */

import { convert } from "html-to-text";
import { createHash } from "node:crypto";
import { CollectionError } from "./errors.js";
import type { NormalizedArticle, PublicationRange } from "./types.js";

export function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return convert(value, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
    ],
  }).replace(/\r\n?/g, "\n").replace(/[\t \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

// Explicit zone required; Date.parse alone accepts impossible days and local times.
export function instant(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDay(match[1]) || +match[2] > 23 || +match[3] > 59
    || +(match[4] ?? 0) > 59) throw new CollectionError("VALIDATION");
  const zone = match[6];
  if (zone !== "Z" && (+zone.slice(1, 3) > 14 || +zone.slice(4) > 59
    || (+zone.slice(1, 3) === 14 && +zone.slice(4) !== 0))) {
    throw new CollectionError("VALIDATION");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new CollectionError("VALIDATION");
  return time;
}

export function validateRange(range: PublicationRange): void {
  if (instant(range.from) >= instant(range.to)) throw new CollectionError("VALIDATION");
}

export function* dayWindows(range: PublicationRange): Generator<PublicationRange> {
  validateRange(range);
  const end = instant(range.to);
  for (let start = instant(range.from); start < end;) {
    const nextMidnight = Math.floor(start / 86_400_000) * 86_400_000 + 86_400_000;
    const next = Math.min(end, nextMidnight);
    yield { from: new Date(start).toISOString(), to: new Date(next).toISOString() };
    start = next;
  }
}

export function inRange(article: NormalizedArticle, range: PublicationRange): boolean {
  const from = instant(range.from), to = instant(range.to);
  if (article.publishedAtUtc) {
    const time = instant(article.publishedAtUtc);
    return from <= time && time < to;
  }
  const day = Date.parse(article.publishedDate);
  return from % 86_400_000 === 0 && to % 86_400_000 === 0 && from <= day && day < to;
}

export function usableContent(content: string, title: string): boolean {
  return /[\p{L}\p{N}]/u.test(content) && content !== title
    && !/^(read more|click here|subscribe(?: to continue)?|all rights reserved)[.!…]*$/i.test(content);
}

export function normalizeArticle(input: NormalizedArticle): NormalizedArticle {
  if (!input || typeof input !== "object") throw new CollectionError("VALIDATION");
  const article = { ...input };
  if (article.metadata !== undefined) {
    const m = article.metadata;
    if (!m || !["news_reference", "corporate_filing", "company_announcement"].includes(m.kind)
      || !["provider_timestamp", "sec_filing_date"].includes(m.publicationBasis)
      || !Array.isArray(m.symbols) || m.symbols.some(s => typeof s !== "string" || !s.trim())
      || !m.details || typeof m.details !== "object" || Array.isArray(m.details)) throw new CollectionError("VALIDATION");
    try {
      const json = JSON.stringify(m, (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error();
        if (["undefined", "function", "symbol", "bigint"].includes(typeof value)) throw new Error();
        return value;
      });
      if (Buffer.byteLength(json) > 65536) throw new Error();
      article.metadata = JSON.parse(json);
    } catch { throw new CollectionError("VALIDATION"); }
  }
  for (const field of ["source", "providerArticleId", "title", "content"] as const) {
    if (typeof article[field] !== "string") throw new CollectionError("VALIDATION");
    // Source adapters clean HTML; shared ingestion treats normalized text as plain text.
    article[field] = article[field].replace(/\r\n?/g, "\n").trim();
    if (!article[field]) throw new CollectionError("VALIDATION");
  }
  for (const field of ["author", "url", "originalPublisher", "language", "publicationSourceText"] as const) {
    if (article[field] !== undefined && typeof article[field] !== "string") {
      throw new CollectionError("VALIDATION");
    }
    article[field] = article[field]?.trim() || undefined;
  }
  if (!validDay(article.publishedDate) || !usableContent(article.content, article.title)
    || !["full", "summary"].includes(article.contentKind)
    || !["day", "hour", "minute", "second", "millisecond"].includes(article.publicationPrecision)
    || (article.language && !/^en(?:[-_]|$)/i.test(article.language))) {
    throw new CollectionError("VALIDATION");
  }
  if (article.publicationPrecision === "day") {
    if (article.publishedAtUtc !== undefined) throw new CollectionError("VALIDATION");
  } else {
    if (typeof article.publishedAtUtc !== "string") throw new CollectionError("VALIDATION");
    article.publishedAtUtc = new Date(instant(article.publishedAtUtc)).toISOString();
    const time = new Date(article.publishedAtUtc);
    if ((article.publicationPrecision !== "millisecond" && time.getUTCMilliseconds() !== 0)
      || (["hour", "minute"].includes(article.publicationPrecision) && time.getUTCSeconds() !== 0)
      || (article.publicationPrecision === "hour" && time.getUTCMinutes() !== 0)) {
      throw new CollectionError("VALIDATION");
    }
  }
  return article;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fingerprints(a: NormalizedArticle) {
  return {
    content: hash([a.title, a.author ?? null, a.publishedDate, a.publishedAtUtc ?? null,
      a.publicationPrecision, a.publicationSourceText ?? null, a.content, a.contentKind]),
    text: hash([a.content, a.contentKind]),
  };
}

// Provider date-only, zoned ISO, or Benzinga's documented numeric-offset RFC format.
export function publication(value: unknown): Pick<NormalizedArticle,
  "publishedDate" | "publishedAtUtc" | "publicationPrecision" | "publicationSourceText"> {
  if (typeof value !== "string") throw new CollectionError("VALIDATION");
  if (validDay(value)) return { publishedDate: value, publicationPrecision: "day", publicationSourceText: value };
  let iso = value;
  const hour = /^(\d{4}-\d{2}-\d{2}T\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (hour) iso = `${hour[1]}:00${hour[2]}`;
  const rfc = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(value);
  if (rfc) {
    const month = String(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(rfc[2]) + 1).padStart(2, "0");
    iso = `${rfc[3]}-${month}-${rfc[1]}T${rfc[4]}${rfc[5]}:${rfc[6]}`;
  }
  const time = instant(iso);
  return {
    publishedDate: iso.slice(0, 10),
    publishedAtUtc: new Date(time).toISOString(),
    publicationPrecision: hour ? "hour" : /\.\d+/.test(iso) ? "millisecond" : /T\d{2}:\d{2}:\d{2}/.test(iso) ? "second" : "minute",
    publicationSourceText: value,
  };
}
