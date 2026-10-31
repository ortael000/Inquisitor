/**
 * Collects SEC issuer disclosures by filing date: resolves CIKs, enumerates
 * submission histories, downloads primary/exhibit documents, and preserves provenance.
 */

import { loadConfig, type SecConfig } from "../config.js";
import { createHash } from "node:crypto";
import { CollectionError } from "../errors.js";
import { hash, inRange, instant, plainText, publication, usableContent, validDay } from "../normalize.js";
import type { SourceFunction } from "../types.js";
import { createCollector, type CollectorRuntime } from "./collector.js";
import { record } from "./http.js";
import { archiveRoot, cik, filingRows, safePath, type Filing } from "./sec/submissions.js";
import { detailDocuments, extractDocument, sgmlDocuments, type FilingDocument } from "./sec/documents.js";

const defaultForms = ["8-K", "8-K/A", "6-K", "6-K/A"];
const supportedForms = [...defaultForms, "10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A"];
const documentLimit = 25 * 1024 * 1024, filingLimit = 100 * 1024 * 1024;
const dayMs = 86_400_000;

/** All configurable dataset choices participate in coverage; operational budgets do not. */
export function secSelection(config: SecConfig) {
  return { forms: [...new Set(config.forms ?? defaultForms)].sort(), exhibits: config.includeExhibits ?? true,
    ciks: Object.entries(config.ciks ?? {}).map(([symbol, value]) => [symbol, cik(value)]).sort(),
    timeMode: "filing_date", mappingPolicy: 1, extractionVersion: 1 };
}

async function selectedDocuments(root: URL, filing: Filing,
  includeExhibits: boolean, getText: (url: URL) => Promise<string>) {
  if (!includeExhibits) return [{ path: filing.primary, type: filing.form, sequence: null, description: "" }] as FilingDocument[];
  let documents: FilingDocument[];
  try { documents = detailDocuments(await getText(new URL(`${filing.accession}-index.html`, root)), root); }
  catch (error) {
    if (!(error instanceof CollectionError) || error.code !== "INCOMPLETE") throw error;
    documents = sgmlDocuments(await getText(new URL(`${filing.accession}.txt`, root)));
  }
  const chosen = documents.filter(d => d.path === filing.primary || /^EX-99(?:\.\d+)?$/i.test(d.type));
  if (!chosen.some(d => d.path === filing.primary)) chosen.unshift({ path: filing.primary, type: filing.form, sequence: null, description: "" });
  return [...new Map(chosen.map(d => [d.path, d])).values()];
}

export function secEdgarCollector(config: SecConfig, runtime?: Partial<CollectorRuntime>): SourceFunction {
  // A bounded run-local metadata cache prevents downloading the same issuer history per daily window.
  const cache = new Map<string, unknown>();
  let cachedBytes = 0;
  let userAgent = "";
  return createCollector({ source: "sec_edgar", config, runtime, defaultIntervalMs: 500, validateProvider() {
    userAgent = process.env[config.userAgentEnv] ?? "";
    if (config.auth !== "none" || !/^[A-Z][A-Z0-9_]*$/.test(config.userAgentEnv ?? "")
      || !/^[^\r\n]+\s+[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userAgent)
      || (config.requestIntervalMs ?? 500) < 500
      || !Array.isArray(config.forms ?? defaultForms) || !(config.forms ?? defaultForms).length
      || (config.forms ?? defaultForms).some(f => !supportedForms.includes(f))
      || (config.includeExhibits !== undefined && typeof config.includeExhibits !== "boolean")) throw new CollectionError("CONFIGURATION");
    for (const limit of [config.maxDocumentBytes ?? documentLimit, config.maxFilingBytes ?? filingLimit]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new CollectionError("CONFIGURATION");
    }
    for (const value of Object.values(config.ciks ?? {})) cik(value);
  } }, async ctx => {
    if (instant(ctx.range.from) % dayMs || instant(ctx.range.to) % dayMs
      || ctx.range.from.slice(0, 4) < "2000") throw new CollectionError("UNSUPPORTED_RANGE");
    const headers = { accept: "application/json", "User-Agent": userAgent };
    let metadataRequests = 0;
    const today = Math.floor(Date.now() / dayMs) * dayMs;
    async function getJson(url: URL) {
      if (++metadataRequests > config.maxPages) throw new CollectionError("TOO_LARGE");
      const cached = cache.get(url.href);
      if (cached !== undefined && instant(ctx.range.to) <= today) return cached;
      const data = await ctx.get(url, headers);
      const bytes = Buffer.byteLength(JSON.stringify(data));
      if (instant(ctx.range.to) <= today && cachedBytes + bytes <= config.maxBytes) {
        cache.set(url.href, data); cachedBytes += bytes;
      }
      return data;
    }
    const issuers = new Map<string, string[]>();
    let mappings: ReturnType<typeof record> | undefined;
    for (const symbol of new Set(config.symbols)) {
      let issuer = config.ciks?.[symbol];
      if (!issuer) {
        mappings ??= record(await getJson(new URL("https://www.sec.gov/files/company_tickers.json")));
        const matches = Object.values(mappings).map(value => record(value)).filter(row => row.ticker === symbol);
        if (matches.length !== 1) throw new CollectionError("CONFIGURATION");
        issuer = cik(matches[0].cik_str);
      }
      const id = cik(issuer);
      issuers.set(id, [...(issuers.get(id) ?? []), symbol]);
    }
    for (const [issuer, symbols] of issuers) {
      const submission = record(await getJson(new URL(`https://data.sec.gov/submissions/CIK${issuer}.json`)));
      if (submission.cik !== undefined && cik(submission.cik) !== issuer) throw new CollectionError("INCOMPLETE");
      if (typeof submission.name !== "string" || !submission.name.trim()) throw new CollectionError("INCOMPLETE");
      const filings = new Map<string, Filing>();
      function addRows(payload: unknown) {
        const rows = filingRows(payload);
        ctx.budget.addItems(rows.length);
        for (const row of rows) {
          const previous = filings.get(row.accession);
          if (previous && hash(previous) !== hash(row)) throw new CollectionError("INCOMPLETE");
          filings.set(row.accession, row);
        }
      }
      addRows(submission);
      const files = record(submission.filings).files;
      if (files !== undefined && !Array.isArray(files)) throw new CollectionError("INCOMPLETE");
      for (const raw of files ?? []) {
        const file = record(raw);
        const from = typeof file.filingFrom === "string" && validDay(file.filingFrom) ? file.filingFrom : undefined;
        const to = typeof file.filingTo === "string" && validDay(file.filingTo) ? file.filingTo : undefined;
        if (from && to && from <= to && (Date.parse(to) < instant(ctx.range.from) || Date.parse(from) >= instant(ctx.range.to))) continue;
        const filename = safePath(file.name);
        if (filename.includes("/")) throw new CollectionError("INCOMPLETE");
        addRows(await getJson(new URL(filename, "https://data.sec.gov/submissions/")));
      }
      for (const filing of filings.values()) {
        if (!(config.forms ?? defaultForms).includes(filing.form)
          || !inRange({ publishedDate: filing.day } as Parameters<typeof inRange>[0], ctx.range)) continue;
        const root = archiveRoot(issuer, filing.accession);
        let filingBytes = 0;
        const read = async (url: URL) => {
          const remaining = Math.min(config.maxDocumentBytes ?? documentLimit, (config.maxFilingBytes ?? filingLimit) - filingBytes);
          if (remaining <= 0) throw new CollectionError("TOO_LARGE");
          const response = await ctx.getBytes(url, { accept: "*/*", "User-Agent": userAgent }, remaining);
          filingBytes += response.bytes;
          const prefix = Buffer.from(response.data).subarray(0, 8192).toString();
          if (/undeclared automated tool|request rate threshold exceeded|<title>[^<]*access denied/i.test(prefix)) throw new CollectionError("ENTITLEMENT");
          return response;
        };
        const documents = await selectedDocuments(root, filing, config.includeExhibits ?? true,
          async url => Buffer.from((await read(url)).data).toString("utf8"));
        if (documents.length > config.maxPages) throw new CollectionError("TOO_LARGE");
        for (const document of documents) {
          const response = document.inline !== undefined
            ? { data: Buffer.from(document.inline), mediaType: /\.txt$/i.test(document.path) ? "text/plain" : "text/html" }
            : await read(new URL(document.path, root));
          const extracted = await extractDocument(response.data, response.mediaType, document.path, config.maxPages);
          const syntheticTitle = !extracted.title;
          const title = extracted.title || `${submission.name} — ${filing.form} — ${filing.day} — ${document.type}`;
          // A selected document is required: rejection here must fail the day, not create empty coverage.
          if (!usableContent(extracted.content, title)) throw new CollectionError("EXTRACTION");
          const isExhibit = /^EX-99(?:\.\d+)?$/i.test(document.type);
          const accepted = ctx.accept(() => ({ source: "sec_edgar", providerArticleId: `${issuer}:${filing.accession}:${document.path}`,
            title, content: extracted.content, contentKind: "full", ...publication(filing.day),
            originalPublisher: plainText(submission.name), url: new URL(document.path, root).href,
            metadata: { kind: "corporate_filing", publicationBasis: "sec_filing_date", symbols: [...symbols].sort(), details: {
              cik: issuer, accession: filing.accession, form: filing.form, items: filing.items,
              reportDate: filing.reportDate, acceptedRaw: filing.acceptedRaw, timestampConflict: "not_assessed",
              documentPath: document.path, documentType: document.type, sequence: document.sequence,
              description: document.description, syntheticTitle, isExhibit,
              selectionMethod: document.inline !== undefined ? "submission_sgml" : (config.includeExhibits ?? true) ? "filing_table" : "primary_metadata",
              checksum: createHash("sha256").update(response.data).digest("hex"), extractionMethod: extracted.method,
              extractionStatus: "completed", languageMethod: "operator_verified", mappingBasis: config.ciks?.[symbols[0]] ? "configured_cik" : "current_ticker_map",
            } } }));
          if (!accepted) throw new CollectionError("EXTRACTION");
        }
      }
    }
  });
}

export const collectSecEdgar: SourceFunction = range => {
  const config = loadConfig().sec_edgar;
  if (!config) throw new CollectionError("CONFIGURATION");
  return secEdgarCollector(config)(range);
};
