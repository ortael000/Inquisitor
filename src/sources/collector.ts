/**
 * Runs the shared collector lifecycle: validation, bounded and paced requests,
 * article acceptance, and safe aggregate reporting. Providers own retrieval loops.
 */

import { validateSource, type SourceConfig } from "../config.js";
import { CollectionError, safeCode, type ErrorCode } from "../errors.js";
import { inRange, normalizeArticle } from "../normalize.js";
import type { NormalizedArticle, PublicationRange, SourceFunction } from "../types.js";
import { Budget, requestJson, type Transport, type ByteTransport } from "./http.js";

interface Counters {
  accepted: number;
  rejectedInvalid: number;
  excludedRange: number;
  missingSummary?: number;
}

type DiagnosticRange = { source: string; from: string; to: string; providerCompleteness?: "unknown" };
export type SourceDiagnostic = DiagnosticRange & (
  | { diagnostic: "history"; coverage: "configured" | "unknown" }
  | ({ diagnostic: "normalization" } & Counters & (
    | { status: "completed" }
    | { status: "failed"; error: ErrorCode }
  ))
);

export interface CollectorRuntime {
  transport: Transport;
  bytesTransport?: ByteTransport;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  report: (event: SourceDiagnostic) => void;
}

export interface CollectorContext {
  range: PublicationRange;
  token: string;
  budget: Budget;
  get: (url: URL, headers?: Record<string, string>) => Promise<unknown>;
  getBytes: (url: URL, headers: Record<string, string>, maxBytes: number) => ReturnType<ByteTransport>;
  reject: (reason: "missing_summary") => void;
  accept: (mapItem: () => NormalizedArticle) => boolean;
}

interface CollectorOptions {
  source: string;
  config: SourceConfig;
  runtime?: Partial<CollectorRuntime>;
  defaultIntervalMs?: number;
  providerCompleteness?: "unknown";
  validateProvider: () => void;
}

/** Creates a range-only function; all mutable state is fresh for each invocation. */
export function createCollector(
  options: CollectorOptions,
  retrieve: (context: CollectorContext) => Promise<void>,
): SourceFunction {
  const { source, config } = options;
  const runtime: CollectorRuntime = {
    transport: requestJson,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => performance.now(),
    report: event => console.log(JSON.stringify(event)),
    ...options.runtime,
  };

  return async range => {
    const articles: NormalizedArticle[] = [];
    const counters: Counters = { accepted: 0, rejectedInvalid: 0, excludedRange: 0 };
    // Copy only known fields: never spread config, provider responses, or exceptions.
    const identity = { source, from: range.from, to: range.to,
      ...(options.providerCompleteness ? { providerCompleteness: options.providerCompleteness } : {}) };
    try {
      const token = validateSource(config, range);
      options.validateProvider();
      runtime.report({ ...identity, diagnostic: "history",
        coverage: config.historyFrom ? "configured" : "unknown" });
      const budget = new Budget(config, runtime.transport, runtime.bytesTransport);
      const interval = config.requestIntervalMs ?? options.defaultIntervalMs ?? 0;
      let nextStart = runtime.now() + interval;

      async function pace() {
          const delay = nextStart - runtime.now();
          if (delay > 0) await runtime.sleep(delay);
          nextStart = runtime.now() + interval;
      }
      const context: CollectorContext = {
        range, budget,
        get token() {
          if (!token) throw new CollectionError("AUTHENTICATION");
          return token;
        },
        async get(url, headers = { accept: "application/json" }) {
          await pace();
          return budget.get(url, headers);
        },
        async getBytes(url, headers, maxBytes) {
          await pace();
          return budget.getBytes(url, headers, maxBytes);
        },
        reject() { counters.rejectedInvalid++; counters.missingSummary = (counters.missingSummary ?? 0) + 1; },
        accept(mapItem) {
          let article: NormalizedArticle;
          try { article = normalizeArticle(mapItem()); }
          catch (error) {
            if (!(error instanceof CollectionError) || error.code !== "VALIDATION") throw error;
            counters.rejectedInvalid++;
            return false;
          }
          // A wrong source is a programmer error, not a malformed provider item.
          if (article.source !== source) throw new CollectionError("INCOMPLETE");
          if (!inRange(article, range)) { counters.excludedRange++; return false; }
          articles.push(article);
          counters.accepted++;
          return true;
        },
      };
      // The adapter must throw unless every query and required detail is complete.
      await retrieve(context);
      runtime.report({ ...identity, diagnostic: "normalization", status: "completed", ...counters });
      return articles;
    } catch (error) {
      runtime.report({ ...identity, diagnostic: "normalization", status: "failed",
        ...counters, error: safeCode(error) });
      throw error;
    }
  };
}
