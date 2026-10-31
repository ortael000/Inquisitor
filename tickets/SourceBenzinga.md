# B1-003 — Implement the Benzinga source function

Status: implemented with synthetic tests; live access requires subscription validation  
Design date: 18 October 2026  
Depends on: [B1-001 — Block 1 article foundation](Block1Implementation.md)

## Purpose and boundary

Collect Benzinga articles for an original-publication range and configured companies/tickers. Return the shared flat `NormalizedArticle[]` through B1-001's `SourceFunction`. The connector owns Benzinga authentication, query/paging, field mapping and source errors. Common ingestion owns SQLite, internal article IDs and the first stored snapshot. [B1-001](Block1Implementation.md) defines article storage, daily coverage, and range-rerun recovery.

Store the **current article body and headline returned at collection** with the **original article creation/publication time**. The design assumes later edits generally do not change the main message, but that assumption is unmeasured. Recollection never changes the first saved snapshot or adds a version row. This connector does not poll `updatedSince`, save historical versions, or estimate an update percentage.

Live WebSocket streaming, market prices, webpage scraping and AI content interpretation are outside this milestone.

## Provider facts and access gates

The News API is `GET /api/v2/news`. It documents date bounds, ticker filters, zero-based pages, selectable full/abstract/headline output and an article `id`. Its `created` timestamp is described as unchanged after the article is created, while `updated` can change repeatedly. Use `created` as the candidate original time after validating its meaning for the subscribed feed; never use `updated` as original publication. [Official News API](https://docs.benzinga.com/api-reference/news-api/get-news-items)

The public endpoint documentation does not establish this account's earliest available history, two-to-three-year coverage, complete body entitlement, local storage rights or original historical wording. Validate these using subscription terms and a bounded entitled probe. A current response with an old `created` value may include later edits.

Before a live run, record the product/subscription, token environment reference, retention rights, body/teaser access, verified history boundary, English policy, ticker semantics, rate limits and timestamp timezone/format. A successful synthetic fixture test does not establish account access.

## Connector requirements

| ID | Requirement |
| --- | --- |
| BZ-R01 | Register source `benzinga`, honor its enabled flag and implement shared `SourceFunction(range)`. |
| BZ-R02 | Query configured companies/tickers and English content under verified provider semantics; no implicit all-news query. |
| BZ-R03 | Request entitled full content; use a genuine source teaser as a summary if body is absent. A headline alone is not enough. |
| BZ-R04 | Use the Benzinga article `id`, represented losslessly as text, as stable `providerArticleId`. Keep it separate from the internal UUID. |
| BZ-R05 | Map a valid original `created` date/time to publication fields and retain actual retrieval time through common ingestion. |
| BZ-R06 | Enumerate all required pages. Split overly large windows/filter shards or fail visibly rather than silently truncate. |
| BZ-R07 | Reject items without title, publication day or usable content; missing author is allowed. |
| BZ-R08 | Do not use the `updated` field for publication, revision creation or update polling in this milestone. |
| BZ-R09 | Keep no raw-response archive, token-bearing request logs or rejected article prose. |

## Retrieval workflow

Implement `collectBenzinga(range): Promise<NormalizedArticle[]>` against the shared function type. The source module loads and validates its own configuration, credentials and reporting/cancellation controls. HTTP transport is replaceable internally for synthetic fixtures.

1. Validate source enablement, credential reference, company mappings, English capability, publication range and declared history access.
2. Build allowlisted request parameters. Redact the API token in every diagnostic. Use provider date filters to cover the requested publication window; locally enforce `[from,to)` for precise timestamps. Confirm date-bound inclusivity and timezone; overfetch a safe adjacent day when necessary.
3. Request full display output with a verified stable sort and page size within provider limits. Confirm whether multiple tickers act as the intended union before using them as one filter.
4. Start at page zero. Continue until the documented termination condition, even when a page contains only invalid or already stored items. Detect repeated pages, malformed responses and offset/item/byte caps.
5. Map each candidate to `NormalizedArticle`. Prefer cleaned usable `body`; otherwise use cleaned usable `teaser` with `contentKind: "summary"`. Print safe invalid-item counts without saving their prose.
6. Return the array only after complete enumeration. Throw on missing pages, unresolved transport/authentication problems or unsafe caps.

Common ingestion fetches manageable windows and freezes the first successful snapshot for each `(benzinga, providerArticleId)`. A later page or run returning a different body under that ID is treated as already stored. The connector does not compare it with the saved text because it has no database access.

### Field mapping

| Shared field | Benzinga rule |
| --- | --- |
| `source` | Constant `benzinga`. |
| `providerArticleId` | String form of article `id`; parse without JavaScript integer precision loss. A missing ID needs a verified stable URL fallback or item rejection. |
| `title` | Cleaned source `title`. |
| `author` | Supplied author, or omit if absent/blank. |
| `publishedDate`, `publishedAtUtc`, `publicationPrecision` | Validated original `created` time if it is confirmed to represent original publication for this product; preserve its offset and precision. |
| `publicationSourceText` | Original `created` field for provenance, when supplied. |
| `content`, `contentKind` | Usable body as `full`; otherwise usable source teaser as `summary`; reject headline-only records. |
| `originalPublisher` | Explicit publisher attribution if provided; do not assume syndicated content originated with Benzinga. |
| `url`, `language` | Source URL/language if available; apply B1-001's English policy. |

Common ingestion adds `retrieved_at`. `updated` may indicate that today's body changed since creation, but the initial design neither stores it as an article version nor uses it to alter `publishedDate`. Benzinga's date-range filters are described as sorted by published date; confirm `created`/publication equivalence with the selected product before declaring mapping acceptance. [Official News API](https://docs.benzinga.com/api-reference/news-api/get-news-items)

## Historical limitation

For an older article collected today, the stored body is today's returned snapshot. The saved publication field is the original source time; `retrieved_at` shows when that snapshot was obtained. Its wording at the original publication time is unverified, so historical analysis must disclose the snapshot assumption and possible look-ahead bias.

There is no removal-event table or removal polling in the MVP. A missing article in a later query does not by itself delete an already stored snapshot. Confirm applicable retention terms before keeping or using explicitly removed content. Benzinga documents removed-news data separately for possible later work. [Removed News API](https://docs.benzinga.com/api-reference/news-api/get-removed-news)

## Configuration, errors and recovery

The source module manages its enabled flag, API token environment reference, company/ticker mappings, English policy, output mode, page size/sort, limits/timeouts and confirmed coverage. The common command does not pass these to `collectBenzinga`. Do not print the token or a request URL containing it.

| Condition | Handling |
| --- | --- |
| Invalid token or unentitled body/history | `AUTHENTICATION` or `ENTITLEMENT`, not a successful empty result. |
| Unsupported range, when verified | `UNSUPPORTED_RANGE`; an empty response alone does not prove this. |
| Rate limit or temporary transport failure | Typed retryable error; common ingestion bounds attempts. |
| Empty complete enumeration | Successful empty array with reason counts. |
| Invalid individual item | Safe finding and discard; continue paging. |
| Missing page, malformed response, repeated page or hard cap | Incomplete/too-large failure, never silent truncation. |
| Interruption | Report the incomplete window; rerun the requested range. |

An interrupted window is refetched from the start. Database uniqueness prevents duplicate provider articles and preserves their first saved snapshots. Do not treat all `404` or other provider error responses as empty news without verifying endpoint semantics.

## Acceptance criteria and backlog

- [ ] BZ-AC01: Synthetic fixtures cover auth/query construction, zero-based pagination, ticker selection, repeated pages and empty results.
- [ ] BZ-AC02: Body, teaser-only summary, missing author, invalid content/date and short valid alerts map to the common article fields.
- [ ] BZ-AC03: Original `created` time is kept for publication when verified; `updated` never replaces it. Date boundaries and timezones are tested.
- [ ] BZ-AC04: Recollecting the same article ID after a changed body/headline keeps one article row, its original snapshot, stable `article_id` and fingerprint.
- [ ] BZ-AC05: Incomplete pages, malformed envelopes, rate limits and caps cause a nonzero failed window; rerunning does not duplicate stored articles.
- [ ] BZ-AC06: Unknown historical coverage is reported as unknown; no synthetic test claims an entitled two-to-three-year backfill.
- [ ] BZ-AC07: Logs and fixtures omit tokens, raw payload archives and unintentionally committed licensed real article bodies.
- [ ] BZ-AC08: A small operator-launched entitled probe verifies actual body/history/filter access and repeat-ingestion behavior before larger collection.

1. Confirm subscription, storage rights, history depth, content access, `created` meaning and filter semantics.
2. Implement injected transport, request construction, pagination and mapping with synthetic fixtures.
3. Integrate common ingestion and prove first-snapshot idempotency and incomplete-window recovery.
4. Run a small entitled live probe; expand history only after its capability gate passes.

| Open item | Owner and decision point |
| --- | --- |
| Subscription, full-body/local-retention rights and credentials | Operator with Benzinga before live collection. |
| Earliest accessible publication date and historical wording/version availability | Operator/provider before two-to-three-year coverage or temporal-validity claims. |
| English eligibility and meaning of `created` as publication | Connector implementer during selected-product mapping validation. |
| Initial ticker list and multi-symbol filter behavior | Operator provides list; implementer verifies before a configured run. |

The connector now follows [B1-004's shared collector pattern](SourceCollectorPattern.md).
Its factory accepts an injected runtime; mapping and the empty-page completion rule
remain in the provider module. See [Adding sources](../docs/AddingSources.md).
No new Benzinga live probe was performed during this refactor.
