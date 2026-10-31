# B1-004 — Source collector pattern and structure

This document explains the current article collectors, how to read a source
module, and which responsibilities are shared or provider-specific. It covers
[Benzinga](SourceBenzinga.md), [Marketaux](SourceMarketaux.md),
[Finnhub](SourceFinnhub.md), and [SEC EDGAR](SourceSecEdgar.md).

## Objective and scope

A collector retrieves articles for an original-publication range and converts
provider responses into `NormalizedArticle[]`. Every source exposes the same
public contract:

```ts
type SourceFunction = (range: PublicationRange) => Promise<NormalizedArticle[]>;
```

The source owns its configuration, credentials, requests, pagination, and mapping.
It returns an array only after all planned requests for the configured selection
complete. Provider-specific evidence determines whether enumeration is exhaustive;
Finnhub explicitly reports provider completeness as unknown.
A failed invocation never returns its buffered partial results.

[Common ingestion](../src/collection.ts) selects sources, splits requests into daily
windows, retries eligible failures, validates returned records, and stores them.
It assigns internal IDs, retrieval times, and fingerprints, preserving the first
stored snapshot for each source article. Collectors do not access SQLite or run
content analysis. The broader contract is defined in [B1-001](Block1Implementation.md).

Collected text is the snapshot currently returned by the provider, associated
with its original publication time. It does not establish the article's exact
wording at that original time.

SEC documents use filing-day precision with `metadata.publicationBasis:
"sec_filing_date"`; this is a disclosure-selection date, not an exact original
press-release timestamp. `metadata.kind` distinguishes filings from news references.
Finnhub summaries remain summaries. Optional validated metadata is persisted
atomically in `articles.source_metadata_json` and stays part of the first stored
snapshot. Content/text fingerprints retain their existing text/time meanings.

## How to read a source module

Read the module in three parts:

1. **Public entry point:** `collectBenzinga(range)` or `collectMarketaux(range)`
   loads its source configuration and invokes the configured collector. The
   caller passes only `{ from, to }`; credentials are resolved internally.
2. **Factory and retrieval callback:** `benzingaCollector(config, runtime?)` or
   `marketauxCollector(config, runtime?)` returns a `SourceFunction` through
   `createCollector(options, retrieve)`. Creating the function does not fetch data.
   Calling it runs the `async ctx => { ... }` callback containing the requests,
   response validation, symbol/page loops, and completion condition.
3. **Mapper:** `mapArticle(raw)` translates one provider item into the shared article
   shape. It defines identity, original publication time, title, content, language,
   attribution, and optional metadata. It performs no network or database work.

Finnhub follows the same entry-point/factory/mapper layout. SEC's factory maps
extracted documents directly; its separate `sec/` modules handle submissions,
document discovery, and extraction so these parsing details stay outside the
retrieval workflow.

Benzinga is the smallest example. Marketaux also has `readPage`, which validates
provider errors and pagination metadata, and `integer`, which safely reads its
numeric metadata fields.

When reading the retrieval callback, identify the query being built, the expected
response structure, where raw candidates are charged, where mapping occurs, and
which exact response proves completion.

## Recurring page-processing pattern

Before this provider-level sequence, shared ingestion checks daily coverage and
can skip the entire source call. Collectors themselves remain independent of SQLite.

Benzinga and Marketaux have an outer symbol loop and an inner numbered-page loop. Each page follows this sequence:

```ts
pages.next();                              // Enforce the cap before fetching.
const response = await ctx.get(url);        // Use shared request infrastructure.
const items = /* provider parsing and validation */;
ctx.budget.addItems(items.length);          // Count raw candidates.
pages.check(items);                        // Detect repeated nonempty pages.
for (const item of items) {
  ctx.accept(() => mapArticle(item));       // Map, validate, filter, and buffer.
}
// Stop or continue according to this provider's completion rule.
```

This snippet shows the recurring sequence; the adapter supplies response parsing
and the completion rule. Invalid articles do not stop pagination. A short page,
an all-invalid page, or known article IDs do not universally establish completion.
When every symbol query completes, the callback resolves and the shared lifecycle
returns the buffer.

Enumeration stays provider-specific. Finnhub makes one guarded date query per
symbol without invented pagination. SEC groups symbols by CIK, follows history
descriptors, and downloads primary/exhibit documents through separate parsing and
extraction helpers. Required-document failures abort the day; sources without
numbered pagination do not need `PageGuard`.

## Daily coverage: avoiding repeated API calls

**A past full UTC day successfully collected for a source and selection is covered
permanently, whether it produced articles or zero articles. Subsequent collections
skip that source call.** Late additions to that publication day are intentionally
excluded from the research dataset unless a refresh is explicitly forced.

Coverage is stored explicitly, rather than inferred from article presence. An
article alone cannot establish that every page was fetched, while an empty day
still needs a durable completion record.

### One shared check for every source

[`configuredSource`](../src/coverage.ts) registers a provider in the CLI with its
configuration, factory, and adapter version:

```ts
configuredSource("benzinga", config.benzinga, benzingaCollector);
configuredSource("marketaux", config.marketaux, marketauxCollector);
configuredSource("finnhub", config.finnhub, finnhubCollector);
configuredSource("sec_edgar", config.sec_edgar, secEdgarCollector, 1, secSelection);
```

The helper snapshots configuration and binds that same snapshot to the factory
and its `coverageKey`. The key hashes the sorted, deduplicated symbol selection,
the English policy, and an adapter version (default 1). Source identity is stored
separately. Changing symbol order or duplicates does not invalidate coverage;
changing the selected companies does. Credentials, pacing, and resource limits
are excluded because they do not change the selected dataset.

Bump the registration's version when fixed query filters, content entitlement,
mapping, or eligibility rules change. A future source with additional configurable
selection filters includes them through the optional fifth selection callback.
Its canonical result is appended to the base scope, preserving existing sources'
keys when no callback is supplied. SEC uses this for CIK overrides, forms, exhibit
policy, and fixed time/mapping/extraction versions. Raw `Source`
objects without a `coverageKey` always fetch; production registrations use the
helper. Direct public collector calls also always fetch because they have no
database context. Coverage belongs to `collect`, the common ingestion entry point.

For each window, [`collection.ts`](../src/collection.ts) does:

```text
If the window is a past full UTC day and matching coverage exists:
    Report skipped / already_covered; do not call the source
Otherwise:
    Retrieve all pages and validate returned articles
    Save eligible articles
    If the window is a past full UTC day and boundary validation rejected nothing:
        Save coverage in the same transaction
```

A full day is exactly UTC midnight to the next UTC midnight, with its end no later
than today's UTC midnight at the time collection starts for that window. Coverage
uses the requested UTC day, not a source-local publication date or retrieval date.

### Storage and behavior

`collection_coverage` contains `source`, `day_utc`, `scope_key`, and `completed_at`.
Its primary key is `(source, day_utc, scope_key)`. It stores successful completion
only; no jobs, failure records, or page checkpoints are needed. Articles and
coverage commit together, including an empty successful result.

| Situation | Behavior |
| --- | --- |
| Covered past full day, same source and selection | Skip all requests for that source window |
| Successful past full day with zero eligible articles | Record coverage and skip on subsequent runs |
| Failed retrieval, pagination, or storage | Create no new coverage |
| Returned records rejected by ingestion's boundary checks | Store valid records but leave the day uncovered |
| Today, future day, or partial-day window | Fetch normally and do not record full-day coverage |
| Different source, selection, or adapter version | Collect independently |
| `--force` | Fetch even when covered; existing article snapshots remain immutable |

Expected invalid provider items discarded inside a collector do not invalidate
successful enumeration; their safe counters remain in source diagnostics.
Ingestion-boundary rejects indicate a source-contract issue and prevent coverage.
Partial-day requests do not reuse whole-day coverage, and partial results are not
combined into full-day coverage.

The CLI reports skipped windows as `status: "skipped"`, `reason: "already_covered"`,
`fetched: null`, and zero insertion/rejection counts. It emits no source diagnostic
for a skipped call because retrieval never runs. Use `--force` only for an explicit
refresh; there is no automatic coverage expiry.

Opening an existing supported article-only database adds the coverage table
automatically and preserves article rows. Existing articles do not generate
coverage records: one complete collection establishes it. Backups preserve both
articles and coverage. This is a completion cache for sequential collection;
simultaneous processes can still both fetch a day before either commits coverage.

## Shared helpers and context

| API or helper | Responsibility |
| --- | --- |
| [`configuredSource`, `pastFullDay`](../src/coverage.ts) | Bind selection to retrieval and identify past full UTC days for shared ingestion coverage |
| [`createCollector`](../src/sources/collector.ts) | Validates prerequisites, creates fresh invocation state, invokes retrieval, buffers accepted articles, and reports completion/failure |
| [`validateSource`](../src/config.ts) | Validates range, enablement, verification flags, symbols, generic limits, history bounds, and credential availability |
| `ctx.range`, `ctx.token` | Supply the requested range and internally resolved credential for query construction |
| `ctx.get(url, headers?)`, `ctx.getBytes(url, headers, maxBytes)` | Apply the same pacing and invocation byte budget to JSON and document requests |
| [`requestJson`](../src/sources/http.ts) | Handles HTTP, timeouts, redirect rejection, bounded bodies, lossless JSON parsing, and safe transport errors |
| `ctx.budget.addItems(count)` | Enforces the raw-candidate limit across the invocation |
| `ctx.accept(mapItem)` | Maps, validates, filters, and buffers; returns whether accepted so required SEC documents can fail explicitly on rejection |
| `ctx.reject("missing_summary")` | Counts unusable Finnhub summaries without manufacturing article content |
| [`PageGuard`](../src/sources/pagination.ts) | `next()` limits requests; `check(items)` rejects repeated nonempty raw pages |
| [`selectContent`](../src/sources/content.ts) | Cleans candidate HTML and selects the first usable text, preserving its declared full/summary kind |
| [`plainText`, `publication`, `normalizeArticle`, `inRange`](../src/normalize.ts) | Provide text cleanup, publication parsing, common article validation, and range filtering |

Each invocation has fresh counters, buffer, budget, and pacing state. Byte and item
budgets span all symbol queries; rejected, out-of-range, and repeated candidates
still consume the item budget. Page guards belong to individual symbol queries,
so identical pages in separate streams do not share duplicate-page state.

`requestIntervalMs` spaces sequential request starts and delays the first request.
A long request can satisfy the next interval. Marketaux defaults to 2200 ms;
SEC defaults to at least 500 ms and Finnhub to at least 1334 ms; Benzinga defaults to zero. This pacing does not coordinate account quotas across
simultaneous invocations or processes.

No-key sources set `auth: "none"` and validate their identifying headers themselves.
Token authentication remains the default. `ctx.token` is a guarded getter: SEC does
not read it or supply a dummy token. The optional byte transport supports document
fixtures; production JSON decoding uses the same bounded binary HTTP reader.

## Provider-specific logic

| Concern | Benzinga | Marketaux |
| --- | --- | --- |
| Authentication | Query `token` | Query `api_token` |
| Selection | One ticker per query | One symbol per query, English filter, grouping disabled |
| Date query | Adjacent-day padding | Second-resolution boundary padding |
| Pagination | Zero-based numbered pages | One-based pages with metadata |
| Completion | Empty raw page | Fetched raw count equals a consistent `found` total |
| Stable identity | Losslessly represented `id` | `uuid` |
| Original publication field | `created` | `published_at` |
| Content preference | Body as full, then teaser as summary | Description, then snippet; both summary |
| Additional validation | Numeric ID conversion and original creation timestamp | Page totals/limits and extra zero fractional timestamp digits |

| Concern | Finnhub | SEC EDGAR |
| --- | --- | --- |
| Authentication | API-key header | Identifying User-Agent, no key |
| Selection | Company-news query per symbol | Symbols resolved/grouped by CIK, configured forms and exhibits |
| Enumeration | One date query per symbol; provider completeness unknown | Recent submissions, overlapping history files, then required documents |
| Stable identity | Lossless news ID; symbol associations merged per call | CIK, accession, and archive document path |
| Time basis | Provider Unix timestamp | Filing date, day precision |
| Content | Genuine summary only | Extracted HTML/plain text or text-layer PDF |
| Required failures | Request/envelope/cap failures abort | Missing or unusable selected documents also abort |

Endpoint URLs, parameter names, authentication placement, provider error decoding,
symbol syntax, query padding, response structure, hard provider caps, and field
mapping remain in each adapter. Benzinga and Marketaux cap page size at 100.
Finnhub and SEC retain the common setting without sending it as pagination.
See their source documents for request/history/document caps.

The local range rule is shared: precise timestamps use `[from,to)`; date-only
records qualify only for whole-day ranges. Missing optional metadata stays absent.
The adapter chooses which original-time field and content candidates to supply.

Page repetition and article uniqueness are separate concerns. Different symbol
queries may return the same article ID. Benzinga and Marketaux preserve those
results; Finnhub merges their symbol associations within the call. Database
uniqueness prevents duplicate stored snapshots in every case.

## Errors and diagnostics

Within `ctx.accept`, only `CollectionError("VALIDATION")` discards an individual
item and increments `rejectedInvalid`. Operational errors, `INCOMPLETE`, budget
failures, and unexpected exceptions abort the invocation. A mapped article with
the wrong source identity also fails the call.

`record(raw, "VALIDATION")` checks an individual discardable candidate.
`record(raw)` checks required response structure and throws `INCOMPLETE`. This
makes a malformed article distinguishable from an untrustworthy enumeration.

A successful empty array can mean zero raw results, all-invalid candidates, or
records excluded by the local range. The source emits aggregate diagnostics:

| Event | Meaning |
| --- | --- |
| `history` | Whether a history start boundary is configured; otherwise reported as unknown |
| `normalization`, completed | `accepted`, `rejectedInvalid`, and `excludedRange` describe processing |
| `normalization`, failed | Counters describe observed work, with a safe error code; no partial array was returned |

Diagnostics exclude tokens, request URLs, provider payloads, and rejected article
prose. Ingestion's summary counts its own boundary `rejected` separately from the
source's `rejectedInvalid`.

Helpers do not retry requests. Ingestion retries eligible errors by restarting the
whole window. A valid Retry-After up to one minute is honored; longer waits
require a later manual run. HTTP 429 without a longer wait is retryable;
Marketaux's `usage_limit_reached`, including its HTTP 402 response, maps to
non-retryable `RATE_LIMIT` because the account quota may be exhausted. The HTTP
helper inspects a bounded 402 error body without logging provider details.

## Reading tests and adding a source

Factories accept `runtime?: Partial<CollectorRuntime>` to inject transport, clock,
sleep, and reporting. Production defaults use real HTTP, time, sleep, and JSON
reporting. Tests use synthetic responses and a clock that advances without waiting.

Shared behavior is covered in [`test/collector.test.ts`](../test/collector.test.ts).
Provider behavior is covered in [`test/sources.test.ts`](../test/sources.test.ts),
[`test/marketaux.test.ts`](../test/marketaux.test.ts),
[`test/finnhub.test.ts`](../test/finnhub.test.ts), and
[`test/sec-edgar.test.ts`](../test/sec-edgar.test.ts).

A new provider supplies its public wrapper, retrieval factory, mapper, and any
response parsers. Reuse the shared helpers and keep the completion condition
explicit. See [Adding an article source](../docs/AddingSources.md) for a complete
example and configuration, registration, and testing instructions.

SEC and Finnhub source details: [SEC EDGAR](SourceSecEdgar.md) uses explicit
no-key identification, safe archive paths, typed exhibits, and filing dates.
[Finnhub](SourceFinnhub.md) uses header authentication, a verified history boundary,
summary-only records, merged invocation associations, and unknown provider
completeness (also reported for empty results). Both use operator-verified English
eligibility while preserving absent language metadata. Neither introduces a
scheduler, revision system, automatic historical refresh, or external-site scraping.
