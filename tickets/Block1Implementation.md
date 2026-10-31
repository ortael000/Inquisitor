# B1-001 — Scalable MVP for article collection

Status: implemented and verified with synthetic fixtures; entitled live probes pending  
Design date: 18 October 2026  
Baseline: [ProjectPlan.md](../.agents/memory/ProjectPlan.md), version 0.9

## Goal and scope

Manually collect English articles for a configured company/ticker list from [Benzinga](SourceBenzinga.md), [Marketaux](SourceMarketaux.md), and [Finnhub](SourceFinnhub.md), plus issuer disclosures from [SEC EDGAR](SourceSecEdgar.md). Store one normalized snapshot of each source record in a local SQLite `articles` table. Generate a permanent `article_id` that future analysis tables can reference. SEC records retain their corporate-filing identity and filing-date basis; they are not independent journalism or precisely timed press releases.

This is the **article-collection MVP** within the larger Block 1 plan. Prices, article-update tracking, source-duplicate clustering, persisted collection jobs/checkpoints, automatic backup, scheduling and UI are later work. All source functions share the same range-only input and normalized output; each handles its own source configuration.

**Historical assumption:** an article collected today is stored with its original publication date/time, even though the currently returned text might include later edits. The user assumes edits usually do not change its main message. This is unverified. Store the actual retrieval time and disclose the assumption in historical research; the snapshot is not proof of original wording.

The **first successfully stored snapshot wins**. Recollecting the same provider article reuses its `article_id` and does not change saved text, publication time or fingerprint. This keeps later analysis results tied to stable inputs.

## MVP requirements

| ID | Requirement |
| --- | --- |
| B1-R01 | Use TypeScript/Node.js and a local SQLite file. |
| B1-R02 | One `articles` table stores title, optional author, source, original publication date/time, full text or source summary, actual retrieval time and a generated `article_id`. |
| B1-R03 | Uniqueness on `(source, provider_article_id)` prevents duplicate article rows across pages, reruns and overlapping ranges. Title/author/date are not identity keys. |
| B1-R04 | Require a usable title, publication day and content. Preserve missing author as `NULL`; mark `full` versus `summary`. |
| B1-R05 | Preserve source publication precision; never invent an hour. Use publication range `[from, to)`, not retrieval time, to select articles. |
| B1-R06 | Store a fingerprint of the frozen article snapshot for future analysis reproducibility. Store an exact-text fingerprint so later code can find possible copies across sources without a relation table. |
| B1-R07 | Each source function accepts only `PublicationRange` and returns `NormalizedArticle[]`. The shared ingestion command handles validation and database insertion. |
| B1-R08 | Run each enabled source independently. Process a large request in small windows, commit completed windows, and safely rerun the same range after failure. |
| B1-R09 | Print a per-source/window summary with counts and status. A provider error or incomplete page set must never be reported as a successful empty range. |
| B1-R10 | Keep credentials outside code and reports. Store no raw API-response archive. Document manual SQLite backup/restore; do not schedule backups. |

## Shared types and responsibilities

```ts
interface NormalizedArticle {
  source: string;                   // Configured source name
  providerArticleId: string;        // Stable ID supplied by the source
  title: string;
  author?: string;
  publishedDate: string;            // Original source day, YYYY-MM-DD
  publishedAtUtc?: string;           // Original UTC time, if known
  publicationPrecision: "day" | "hour" | "minute" | "second" | "millisecond";
  content: string;                  // Readable text or source summary
  contentKind: "full" | "summary";
  url?: string;
  originalPublisher?: string;
  language?: string;
  publicationSourceText?: string;   // Original date/time field, if supplied
  metadata?: SourceMetadata;        // Validated kind, time basis, symbols and provider details
}

interface PublicationRange {
  from: string;                     // UTC ISO instant, inclusive
  to: string;                       // UTC ISO instant, exclusive
}

type SourceFunction = (range: PublicationRange) => Promise<NormalizedArticle[]>;
```

The source module reads its own enabled flag, company symbols, credentials or identifying headers, limits and provider options. It completes the provider-specific retrieval plan before returning an array. Finnhub explicitly reports provider completeness as unknown; a successful query is not proof of exhaustive coverage. Invalid individual items may be omitted with a safe source-local count; missing pages, authentication errors and required-document failures throw. The common ingestion command adds `article_id`, `retrieved_at` and fingerprints and inserts the array. No source function opens SQLite.

The common command selects sources and windows. Source configuration remains in a simple file/environment variables, without a `SourceSettings` parameter. Each source can print or return safe aggregate diagnostics through its module; the function's public result remains `NormalizedArticle[]`. Do not log API keys, raw response bodies or rejected article prose.

## Normalization and time

- Clean HTML into readable plain text, preserving paragraphs, quotations, numbers and wording. Accept a usable provider body as `full`, or a usable provider summary as `summary`; a headline or boilerplate alone is insufficient.
- Validate real calendar days. Reject items missing title, day or usable content. A missing author is acceptable. Do not fill publication date from retrieval or update time.
- Normalize justified precise publication times to UTC. Preserve the source day and time precision; date-only items have no `publishedAtUtc`. An unknown timezone must not become an invented UTC hour.
- Apply `[from,to)` to precise times. Date-only items are eligible for whole-day requests using their stated day; exclude them from intraday selection because ordering is uncertain.
- Collect configured English/company coverage only after verifying each provider's filter semantics. A configured symbol list is required; an empty list does not mean all news.

## SQLite schema

The article schema is in `sql/001_articles.sql`; daily completion is in `sql/002_collection_coverage.sql`. `sql/003_source_metadata.sql` adds a nullable validated `source_metadata_json` column for record kind, time basis, symbols, and provider/extraction provenance. Metadata is immutable with the first snapshot and does not change the existing fingerprint definition. Setup/opening verifies the exact supported schema and automatically adds missing coverage and metadata to compatible databases. Incompatible schemas fail without replacement. The SQL below shows the base article schema before these additive migrations. Use parameterized statements, `PRAGMA foreign_keys=ON`, and short transactions. WAL is a practical local default if readers and collection may overlap; SQLite still allows one writer at a time. [SQLite guidance](https://www.sqlite.org/whentouse.html), [WAL](https://www.sqlite.org/wal.html)

```sql
CREATE TABLE articles (
  article_id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  provider_article_id TEXT NOT NULL CHECK (length(trim(provider_article_id)) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  author TEXT,
  original_publisher TEXT,
  url TEXT,
  published_date TEXT NOT NULL,
  published_at_utc TEXT,
  publication_precision TEXT NOT NULL
    CHECK (publication_precision IN ('day','hour','minute','second','millisecond')),
  publication_source_text TEXT,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  content_kind TEXT NOT NULL CHECK (content_kind IN ('full','summary')),
  language TEXT,
  content_fingerprint TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  UNIQUE (source, provider_article_id),
  CHECK ((publication_precision = 'day' AND published_at_utc IS NULL)
      OR (publication_precision <> 'day' AND published_at_utc IS NOT NULL))
);

CREATE INDEX articles_publication_day ON articles(published_date);
CREATE INDEX articles_publication_time ON articles(published_at_utc);
CREATE INDEX articles_exact_text ON articles(content_kind, text_fingerprint);
```

Validate dates and fingerprints in TypeScript; the SQL checks only basic shape. Generate `article_id` as a UUID in the application. `content_fingerprint` hashes an unambiguous serialization of normalized title, nullable author, publication fields, content and content kind. `text_fingerprint` hashes normalized content and kind for an exact-text lookup; compare actual text before asserting an exact copy. Do not treat a shared fingerprint as a proven independent-story cluster.

On `(source, provider_article_id)` conflict, read and reuse the existing row/ID. Do not use `REPLACE` or update the frozen article fields. Existing analysis results can therefore refer to `article_id` plus `content_fingerprint` without a revision table. A future schema can add tables linked by `article_id` without changing this key.

## Simple collection and recovery

1. Validate the requested `[from,to)` range, selected enabled sources and required provider symbol mappings.
2. Split large requests into small date windows, initially one day. Let each source function paginate internally and return a complete array for its window.
3. Validate returned articles again at the shared boundary. For each eligible item, insert if its `(source, provider_article_id)` is new; otherwise reuse its existing ID. Commit each completed window in a short transaction.
4. Print one summary per source/window: fetched, inserted, already stored, rejected and completed/failed. Include a safe error code for unsupported history, auth failure or incomplete enumeration. Do not claim a failed window was empty.
5. If a window fails, stop or continue according to a documented command option and exit nonzero overall. Previously committed windows remain. Rerun the **same requested range** to resume: daily coverage skips completed past days and uniqueness preserves already stored articles. No checkpoint table or page cursor persistence is needed for the MVP.

The range-only function returns arrays, so a single window needs an item/byte limit. If the provider result exceeds it, split the window or configured ticker group where provider semantics allow; otherwise fail clearly. Do not silently drop pages. A provider cursor used within one call is temporary.

A small `collection_coverage` table records successful past full UTC days by source and selection, including zero-article days. Ingestion skips matching covered days before calling a source; `--force` explicitly refreshes them. Articles and coverage commit together. Failed or partial-day collections do not establish daily coverage, and existing article rows are not backfilled into coverage. Late additions to covered days are intentionally excluded. See [the source collector coverage pattern](SourceCollectorPattern.md#daily-coverage-avoiding-repeated-api-calls). Detailed run/window findings, checkpoints, article observations, duplicate relationships, and removal events remain deferred.

## Configuration, backup and downstream handoff

Each source module manages its own enabled flag, API credential environment reference, English/company filters, page size and timeout. The common command selects enabled modules and uses their source names. Keep the configuration example free of secrets. Test with synthetic transport fixtures before an entitled provider probe.

No backup scheduler is included. Document an explicit consistent SQLite backup command and an isolated restore check; copying only the main file of an active WAL database is unsafe. [SQLite backup API](https://www.sqlite.org/backup.html)

Block 2 can reference `articles.article_id` and `content_fingerprint`. Block 3 can count distinct `article_id` values; it must decide later whether exact-text matches across sources count as one story. Block 4 uses original publication time, not `retrieved_at`, for recent filtering. Saved text may contain later edits, so historical analysis must label the snapshot assumption and possible look-ahead bias.

## Acceptance criteria

- [ ] B1-AC01: Initialize and query the article and daily-coverage schema; duplicate `(source, provider_article_id)` is rejected by the database.
- [ ] B1-AC02: All source functions take only `PublicationRange` and return the shared `NormalizedArticle[]` shape.
- [ ] B1-AC03: Valid full text and source summaries store correctly. Missing author passes; missing title/day/content and invalid days are rejected.
- [ ] B1-AC04: Original publication time, precision and actual retrieval time remain distinct. Date-only articles never gain a fabricated hour.
- [ ] B1-AC05: Rerunning a completed or partly failed range creates no duplicate rows. A changed provider body does not overwrite the first saved snapshot.
- [ ] B1-AC06: An incomplete provider page set fails its window and the overall command; the output distinguishes this from a successful zero-article window.
- [ ] B1-AC07: An identical article from another source keeps its own ID; its exact-text fingerprint can be found without a relation table.
- [ ] B1-AC08: No credentials or raw provider responses are saved. Manual backup restores a readable database in isolation.
- [ ] B1-AC09: A future analysis can reference `article_id` plus `content_fingerprint` without article versioning.

## Implementation order and deferred work

The additional [SEC EDGAR](SourceSecEdgar.md) and [Finnhub](SourceFinnhub.md)
collectors are implemented and verified offline. They reuse the existing range
contract, daily coverage, budgets, and atomic storage. SEC adds document parsing
helpers; Finnhub remains summary-only with unknown provider completeness. Both
start disabled in the example. Finnhub AAPL access has since been live-probed;
SEC has not. Their tickets define configuration,
time semantics, and the remaining account/access checks.

1. Confirm provider access, local-storage rights, article ID/original-time mapping, body availability and selected company symbols.
2. Build the flat shared types, article/coverage schema and insertion/validation command with a synthetic source.
3. Implement the Benzinga and Marketaux functions with bounded pagination and synthetic fixtures.
4. Run a small entitled live probe for each provider, then manually collect selected windows and inspect summaries.

| Deferred item | Add when needed |
| --- | --- |
| Durable collection runs, checkpoints, findings and fine-grained retries | Collections become too large for simple window reruns or require audit history. |
| Persisted duplicate/story relationships | Research defines clustering and source-diversity features. |
| Article update/version handling | The current-snapshot assumption becomes unacceptable or measured edits materially affect results. |
| Automated backup/scheduling, multiple writers or server database | Operational load or deployment requires them. |
| Price collection | Separate Block 1 milestone. |

Unknown provider coverage and entitlements remain open in the two source tickets. The MVP implementation and operating commands are documented in [README.md](../README.md). Synthetic tests cover the acceptance criteria, including immutable snapshots, partial-failure recovery and isolated backup restoration. Benzinga has not been live-probed; account-specific mappings, filters, rights and historical coverage still require verification. At the user's later request, [Marketaux](SourceMarketaux.md) was added as a summary-only testing source: a small live collection and immutable-snapshot rerun were verified on 18 October 2026.
