/**
 * Defines the shared article-collection contracts: publication ranges, normalized
 * article records, collector functions, and source registry entries.
 */

export interface PublicationRange {
  from: string;
  to: string;
}

export interface NormalizedArticle {
  source: string;
  providerArticleId: string;
  title: string;
  author?: string;
  publishedDate: string;
  publishedAtUtc?: string;
  publicationPrecision: "day" | "hour" | "minute" | "second" | "millisecond";
  content: string;
  contentKind: "full" | "summary";
  url?: string;
  originalPublisher?: string;
  language?: string;
  publicationSourceText?: string;
  metadata?: SourceMetadata;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface SourceMetadata {
  kind: "news_reference" | "corporate_filing" | "company_announcement";
  publicationBasis: "provider_timestamp" | "sec_filing_date";
  symbols: string[];
  details: { [key: string]: JsonValue };
}

export type SourceFunction = (range: PublicationRange) => Promise<NormalizedArticle[]>;
export interface Source {
  name: string;
  enabled: boolean;
  collect: SourceFunction;
  /** Stable fingerprint of selection and adapter version; omitted sources always fetch. */
  coverageKey?: string;
}
