# B1-006 — Finnhub company-news source

Status: implemented; synthetic tests pass; authenticated AAPL access probed  
Updated: 19 October 2026  
Contracts: [article ingestion](Block1Implementation.md), [collector pattern and coverage](SourceCollectorPattern.md)  
Companion: [SEC EDGAR](SourceSecEdgar.md)

## Objective and scope

`finnhub` collects company-news headlines, usable summaries, publisher labels, URLs,
and publication timestamps. Summaries remain summaries. It does not retrieve full
publisher articles, images, market-news feeds, sentiment, or paid press releases.

The implementation adapts the supplied `SEC_Finnhub_Codex_Implementation_Spec.md`
to the project's existing range-only source functions and permanent daily coverage.
It adds no revision history, periodic overlap, scheduler, or per-symbol checkpoint
system. First stored article and metadata snapshots remain immutable.

## Reading the implementation

[`src/sources/finnhub.ts`](../src/sources/finnhub.ts) contains:

1. `mapArticle`: lossless identity, UTC timestamp, summary and provenance mapping.
2. `finnhubCollector(config, runtime?)`: verified-history validation, guarded company
   queries, response checks, and duplicate-ID association merging.
3. `collectFinnhub(range)`: the public wrapper that loads its own configuration.

The factory reuses `createCollector`, shared transport, pacing, budgets, acceptance,
and reporting. CLI registration uses `configuredSource("finnhub", config.finnhub,
finnhubCollector)`. Common ingestion owns the database and daily coverage.

## Configuration and eligibility

The checked-in example is disabled. Configure provider symbols, `FINNHUB_API_KEY`
through `tokenEnv`, the three verification flags, and an explicit verified
`historyFrom` timestamp before collection. Missing history configuration fails
before the API is called rather than establishing misleading empty-day coverage.

The source enforces the later of that verified boundary and one calendar year
before the current UTC day, clamping leap days. Requests before that boundary
fail with `UNSUPPORTED_RANGE`; they are not silently shortened. `historyTo` can
further bound access. The handoff's one-year free history and actual symbol/summary
access still require account verification, not inference from empty responses.

Pacing defaults to 1334 ms and cannot be configured lower. Calls are sequential;
`maxPages` bounds the number of company requests, not provider pagination.
`maxItems`, `maxBytes`, and `timeoutMs` bound the invocation. The retained common
`pageSize` setting is not sent to this endpoint.

Finnhub's response does not establish author or language. English eligibility is
gated by the operator's `englishVerified` setting; records retain absent language,
with `languageMethod: "operator_verified"` provenance. Do not enable the source on
an unverified assumption that a US ticker guarantees English. Local language
classification is not introduced by this implementation.

## Requests, mapping, and completeness

For each distinct symbol, request:

```text
GET https://finnhub.io/api/v1/company-news?symbol=...&from=YYYY-MM-DD&to=YYYY-MM-DD
X-Finnhub-Token: <key from environment>
Accept: application/json
```

Date queries use a one-day guard around the requested UTC interval, clipped at
configured entitlement boundaries. Exact `[from,to)` filtering happens locally.
Never send `minId`, `page`, `offset`, `limit`, or guessed full-text flags. Company
news does not expose the reviewed market-news endpoint's pagination contract.

| Field | Mapping |
| --- | --- |
| `source` | `finnhub` |
| `providerArticleId` | Exact `id` string, including losslessly parsed large numeric IDs |
| Publication fields | Integer `datetime` Unix seconds converted to UTC, second precision; original number text retained |
| `title` | Cleaned `headline` |
| `content`, `contentKind` | Usable cleaned `summary`, always `summary` |
| `originalPublisher` | Reported `source`, without inferring original wire identity |
| `url` | Original URL including identifying query parameters |
| Metadata | Requested symbols, raw `related`, category, query association method, unknown editorial type and provider completeness |

Duplicate IDs across symbol queries merge their sorted requested-symbol associations
within an invocation; the first returned payload wins. Cross-run association updates
and revision tracking are not performed. Missing IDs are rejected safely.
Missing/unusable summaries are counted separately as `missingSummary`; no headline
is copied into `content` and no metadata-only article is fabricated.

The provider must return an array. Error dictionaries, HTML, malformed responses,
authentication/entitlement errors, timeouts, or candidate/byte caps fail the window.
One failed symbol prevents partial-day insertion; previously committed days and
independent sources survive.

Source diagnostics, including empty successful invocations, carry
`providerCompleteness: "unknown"`. Successful planned requests do not establish
exhaustive provider coverage. No undocumented saturation threshold is invented.

## Coverage, storage, and retention

A successfully processed past full day is permanently covered for the source and
symbol selection, including zero eligible summaries. There is no automatic
72-hour overlap or watermark refresh. Today and partial days do not establish
coverage; failed/unsupported windows do not create coverage. `--force` explicitly
refetches and still preserves first snapshots.

Source metadata is validated and stored in the nullable `source_metadata_json`
article column in the same transaction as articles and daily coverage. Existing
schemas upgrade without changing article IDs, content fingerprints, or coverage.
Keys/headers/raw responses are not stored in metadata or diagnostics.

Verify the current account and [terms](https://finnhub.io/terms-of-service) before
live use. Keep the `finnhub` lineage on records and future derived outputs so any
applicable retention/deletion requirements can be met. An automatic purge of all
future derived artifacts is not claimed.

## Verification and operating gate

[`test/finnhub.test.ts`](../test/finnhub.test.ts) covers allowlisted parameters and
authentication, date guards and leap-year cutoff, summary/identity rejections,
large IDs, merged associations, error/cap handling, daily empty/nonempty skips,
force-refresh immutability, metadata persistence, and failed-symbol atomicity.
Shared regression tests cover byte limits, pacing, safe errors, schema migration,
backups, and existing sources.

On 19 October 2026, authenticated read-only AAPL company-news probes returned HTTP
200: 81 items with summaries for 16 October, and 14 for 10 October. Sample fields
confirmed IDs, Unix publication timestamps, and English summary text. These checks
establish recent endpoint access, not exhaustive coverage, a feed-wide language
guarantee, or a legal assessment of storage rights. No probe articles were saved.
Wider history and other symbols remain unverified.

## Current local setup and running collection

The ignored `config/sources.json` now enables Finnhub for `symbols: ["AAPL"]`,
references `FINNHUB_API_KEY`, and sets `historyFrom: "2026-10-10T00:00:00Z"`.
The three operational verification flags are enabled for the requested local
setup. Other sources retain their existing settings. The checked-in example
remains disabled. English eligibility is an operator assumption supported by the
inspected samples, not automatic language detection or a provider guarantee.

The key is stored in the Windows **user environment**, outside the repository.
After restarting VS Code it is inherited by new terminals. To reload it in an
already-open PowerShell terminal without displaying its value:

```powershell
$env:FINNHUB_API_KEY = [Environment]::GetEnvironmentVariable("FINNHUB_API_KEY", "User")
```

From the project directory, collect **10 through 17 October 2026 inclusive**:

```powershell
npm.cmd run collect -- --sources finnhub --from 2026-10-10T00:00:00Z --to 2026-10-18T00:00:00Z
```

The end is exclusive, so midnight on 18 October includes the whole of 17 October.
Dates use UTC. This calls the source through shared ingestion and stores summaries
in `data/inquisitor.sqlite`; any supported pending schema migrations apply on open.
Local configuration validation and a read-only supported-schema check passed.
The eight-day collection itself has not been run as part of configuration.
Completed past days, including zero-summary days, will be skipped on rerun.
Use `--force` only to explicitly refetch; first stored snapshots remain unchanged.

References from the supplied handoff: [company news](https://finnhub.io/docs/api/company-news),
[authentication introduction](https://www.finnhub.io/docs/api/country),
[pricing](https://finnhub.io/pricing), and
[official SDK endpoint mappings](https://github.com/Finnhub-Stock-API/finnhub-python/blob/master/finnhub/client.py).
The JavaScript-rendered pages did not expose full plan details to the preparation
browser; account-specific access and exhaustive retrieval are not asserted.
