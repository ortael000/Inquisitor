# Adding an article source

Start with [Benzinga](../src/sources/benzinga.ts), the smallest current adapter.
Read it in this order: `mapArticle`, `benzingaCollector`, `collectBenzinga`.
The same structure appears in Marketaux, Finnhub, and SEC EDGAR; each retains its own enumeration rule.

## The three parts of an adapter

1. **Mapping:** a pure `mapArticle(raw)` function translates one complete provider
   item into `NormalizedArticle`. It chooses identity, original publication time,
   language, attribution, and content fields. Shared acceptance validates it later.
2. **Retrieval:** `exampleCollector(config, runtime?)` creates a collector using
   `createCollector`. Its callback builds requests, validates envelopes, and
   enumerates every page or other discovery unit and required detail. Keep its completion rule explicit.
3. **Public entry point:** `collectExample(range)` loads the provider configuration
   internally and calls the factory. The CLI passes only the publication range.

For metadata-based pagination, see
[Marketaux](../src/sources/marketaux.ts).

## What the shared context does

| API | Use it for |
| --- | --- |
| `ctx.range` | Original requested `[from,to)` range; provider query padding stays in the adapter |
| `ctx.token` | Internally resolved credential; put it only in the provider request |
| `ctx.get(url, headers?)` | JSON requests with byte budget, timeout, and configured pacing; defaults to JSON Accept header |
| `ctx.budget.addItems(count)` | Charge raw candidate count before mapping, filtering, or deduplication |
| `ctx.accept(() => mapArticle(raw))` | Normalize, validate, filter the local range, and buffer eligible articles |

`createCollector` handles prerequisite validation, counters, safe diagnostics,
and returning the buffer after your callback completes. Do not return partial
results yourself. Throw if enumeration cannot be proven complete. Whole-window
retries and persistence live in `src/collection.ts`.

## Minimal example

This illustrates a hypothetical provider whose documented completion rule is an
empty page. Adapt its URL, fields, limits, authentication, and completion rule to
the actual provider. The endpoint below is deliberately an example domain.

```ts
import { loadConfig, type SourceConfig } from "../config.js";
import { CollectionError } from "../errors.js";
import { plainText, publication } from "../normalize.js";
import type { NormalizedArticle, SourceFunction } from "../types.js";
import { createCollector, type CollectorRuntime } from "./collector.js";
import { selectContent } from "./content.js";
import { record } from "./http.js";
import { PageGuard } from "./pagination.js";

function mapArticle(raw: unknown): NormalizedArticle {
  const item = record(raw, "VALIDATION");
  if (typeof item.id !== "string") throw new CollectionError("VALIDATION");
  const title = plainText(item.title);
  return {
    source: "example", providerArticleId: item.id, title,
    ...publication(item.published_at),
    ...selectContent(title, [
      { value: item.body, kind: "full" },
      { value: item.summary, kind: "summary" },
    ]),
    language: "en", // Only if the verified feed guarantees English.
  };
}

export function exampleCollector(config: SourceConfig, runtime?: Partial<CollectorRuntime>): SourceFunction {
  return createCollector({ source: "example", config, runtime, validateProvider() {
    if (config.pageSize > 100) throw new CollectionError("CONFIGURATION");
  } }, async ctx => {
    for (const symbol of new Set(config.symbols)) {
      const pages = new PageGuard(config.maxPages);
      for (let page = 1; ; page++) {
        pages.next(); // Fail before fetching beyond the configured page cap.
        const url = new URL("https://news.example.invalid/articles");
        url.search = new URLSearchParams({
          symbol, from: ctx.range.from, to: ctx.range.to,
          page: String(page), limit: String(config.pageSize),
        }).toString();
        const items = await ctx.get(url, {
          accept: "application/json", Authorization: `Bearer ${ctx.token}`,
        });
        if (!Array.isArray(items) || items.length > config.pageSize) {
          throw new CollectionError("INCOMPLETE");
        }
        ctx.budget.addItems(items.length);
        pages.check(items);
        for (const item of items) ctx.accept(() => mapArticle(item));
        if (items.length === 0) break;
      }
    }
  });
}

// Add `example` to Config before using this wrapper.
export const collectExample: SourceFunction = range => exampleCollector(loadConfig().example)(range);
```

## Helper rules

`PageGuard.next()` bounds requests; `check(rawItems)` detects repeated nonempty
pages. Use a fresh guard for each symbol/query stream. The adapter determines
which response proves completion.

`selectContent` cleans HTML and chooses the first usable candidate, preserving
its declared full/summary kind. Never fill missing content with the title.

Use `record(raw, "VALIDATION")` for an individual malformed item that can safely
be discarded. Use `record(raw)` for required page structure: it throws
`INCOMPLETE`, which aborts the call. Shared acceptance discards only `VALIDATION`;
operational errors and unexpected exceptions propagate. Network requests belong
outside the mapper.

Bytes and raw candidates are limited across an entire invocation, including all
symbol queries. Charge rejected and out-of-range records too. Page caps apply per
enumeration stream. Do not remove duplicate article IDs across symbol queries:
database uniqueness preserves first snapshots, and returned counts keep their meaning.

`requestIntervalMs` spaces sequential request starts and delays the first request.
Long requests can satisfy the next interval. Marketaux defaults to 2200 ms;
Benzinga defaults to zero. Each invocation, including a retry, starts fresh.
This does not coordinate account quotas across simultaneous invocations/processes.

## Tests and registration

Use `sequenceRuntime` from `test/helpers/source-fixtures.ts` to inject responses,
capture requests, and advance a fake clock without network access or real sleeps.
Call `assertDone()` after successful enumeration to check every fixture response
was consumed. Failure tests may intentionally leave responses unread.

Cover query construction, complete empty output, invalid items that do not stop
paging, malformed/incomplete enumeration, resource caps, original-time and
identity mapping, and immutable snapshot integration. The shared tests in
`test/collector.test.ts` cover acceptance, safe diagnostics, pacing, and guard
behavior. Add a small wrapper test to verify configuration loading.

Register the source in `Config`, `loadConfig`, `config/sources.example.json`, and
the CLI registry in `src/cli.ts`. Register with the shared helper:

```ts
configuredSource("example", config.example, exampleCollector);
```

Import `configuredSource` from `./coverage.js` in the CLI. It binds the same private
configuration snapshot to retrieval and a coverage fingerprint of symbols, English
policy, and adapter version. Shared ingestion skips successfully covered past full
UTC days, including zero-article days. Direct collector calls do not use coverage.
Pass a new fourth argument (version) when mapping, fixed filters, eligibility, or
content access changes. Include any new configurable selection filters in the
scope fingerprint through the optional fifth selection callback. SEC's `secSelection` is an example. Operational limits and credentials
do not invalidate coverage. See the [coverage rules](../tickets/SourceCollectorPattern.md#daily-coverage-avoiding-repeated-api-calls).

Keep the source disabled in the example until configured.
Document its provider policies and access gates in a source ticket, then run:

```powershell
npm.cmd run check
npm.cmd test
```

Source diagnostics have `diagnostic: "history"` or `"normalization"`. Normalization
events report `status`, `accepted`, `rejectedInvalid`, and `excludedRange`, plus a
safe error code on failure. These counts describe the source invocation; the
ingestion summary's `rejected` counts its own boundary validation. A failed event
may describe articles buffered before failure, but none of them were returned.

## Sources with different access or content

Use `auth: "none"` for a public API with no key, then validate any identifying
headers in `validateProvider`. SEC uses `SEC_USER_AGENT`. Token authentication is
the default and `ctx.token` throws if accessed by a source without a token.

`ctx.getBytes(url, headers, maxBytes)` uses the same pacing and invocation budget
as JSON fetching. Inject `bytesTransport` for document fixtures. Parsers and
extractors stay provider-specific, as in `src/sources/sec`. If a required document
is rejected, use the boolean return from `ctx.accept` to fail the call instead of
silently covering a day with missing content.

Optional `metadata` records document/news class, publication basis, associations,
and selected provenance. It is validated, limited to 64 KiB JSON, persisted in
`source_metadata_json`, and immutable with the first stored snapshot. Never put
credentials, raw API payloads, or retrieval instructions into it. Content/text
fingerprints keep their existing text/time semantics.

There is no universal page loop: Finnhub uses company-date queries, while SEC uses
issuer history descriptors plus required documents. Unknown provider completeness
can be declared on the shared lifecycle; completed requests are not a proof of
exhaustive provider coverage. English eligibility still needs operator verification
when the response does not provide language metadata.
