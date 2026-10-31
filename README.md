# Inquisitor

Local article collection for financial research (Block 1). TypeScript, Node.js
22.17 or newer, and Node's bundled SQLite implementation. SQLite is experimental
in Node 22 and prints a runtime warning.

## Setup

From this directory in PowerShell:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run setup
Copy-Item config/sources.example.json config/sources.json
```

`setup` creates `data/inquisitor.sqlite` with `articles`, its indexes, and a small
`collection_coverage` table. Opening a supported article-only database automatically
adds coverage and an optional provenance JSON column without changing existing
article snapshots. Supported coverage-only databases gain the same metadata column. Repeating setup verifies the schema;
incompatible schemas fail without replacement. Collection requires an initialized database.
Use `--db path/to/database.sqlite` to select another database.

## Configure a source

All sources start disabled in the example. Edit the ignored `config/sources.json`, or set
`INQUISITOR_CONFIG` to another JSON file. Each source reads its own configuration;
its public collection function takes only `{ from, to }`.

Before enabling a source, confirm the contracted product, local retention rights,
body/summary access, original-publication semantics, English eligibility, company
filters and accessible history using the provider and a small entitled probe.
Record the outcome locally, without credentials or article prose. Then set:

| Setting | Meaning |
| --- | --- |
| `enabled` | Include this source in collection. |
| `symbols` | Required provider tickers, such as `AAPL`. Empty never means all news. |
| `tokenEnv` | Name of the token environment variable; SEC instead uses `auth: "none"` and `userAgentEnv`. |
| `accessVerified` | Operator has confirmed subscription, body/summary access and local storage rights. |
| `englishVerified` | English filtering or feed language guarantee has been verified. |
| `mappingVerified` | Original time, stable identity, company/date filters and pagination have been verified for this product. |
| `historyFrom`, `historyTo` | Verified UTC bounds (inclusive start, exclusive end). Outside ranges fail. Finnhub requires `historyFrom`; other sources report omitted history as unknown. |
| `pageSize` | Benzinga/Marketaux: 1–100 items per page. Retained but not sent by Finnhub/SEC. |
| `maxPages`, `maxItems`, `maxBytes` | Hard limits per window, including rejected candidates and overfetch. Exceeding a limit fails the window. |
| `timeoutMs` | Timeout for each HTTP request, including reading its body. |
| `requestIntervalMs` | Minimum spacing between sequential request starts, including an initial delay. Defaults: Marketaux 2200 ms, Benzinga zero, SEC 500 ms, Finnhub 1334 ms. SEC/Finnhub reject lower values; scoped to one collector invocation. |

Credentials belong in process environment variables or an external secret manager,
never in configuration JSON. The application does not load `.env` files. Config,
databases, backups and `.env` are ignored by Git.

Provider adapters:

- **Marketaux:** `GET /v1/news/all`, using `MARKETAUX_API_TOKEN`. Queries configured
  tickers individually with `language=en` and `group_similar=false`, so the
  provider does not collapse related articles. Uses `uuid` for identity and
  `published_at` for publication. Stores a usable description, or a snippet when
  needed, as `summary`; it does not fetch full publisher pages or sentiment data.
  Pagination starts at 1 and checks `found`, `returned`, `limit` and `page`.
  Missing/changing metadata, incomplete pages and caps fail the window. Extra
  zero fractional timestamp digits are removed for millisecond storage while
  preserving the original timestamp text; finer nonzero precision is rejected.
  Free-plan defaults are 3 articles/page and at most 30 pages per source window.
  Larger result sets fail rather than silently storing a partial collection.
  For example, a day with 110 results needs `maxItems` of at least 110 and
  `maxPages` of at least 37 at 3 articles/page. Raise these limits only within
  your remaining daily request quota. Request pacing also applies on reruns.
- **Benzinga:** `GET /api/v2/news`, `full` output, `created:asc`, zero-based
  pages until an empty page. Queries one ticker at a time to avoid assuming
  multi-ticker union semantics. Overfetches adjacent days, then checks original
  `created` locally. The verified feed must guarantee English when no language
  field is supplied; the API's documented query has no English parameter.
  Numeric IDs are parsed losslessly. Body falls back to genuine teaser text.

- **Finnhub:** company-news summaries via `/company-news` and header
  `X-Finnhub-Token`. No invented pagination or full-body fetches. Requires an
  explicitly verified `historyFrom` and enforces a rolling calendar-year floor.
  Preserves unknown language and provider completeness, while requiring the
  operator to verify English eligibility. Duplicate IDs merge query-symbol
  associations within a call. Empty summaries are counted and rejected.
- **SEC EDGAR:** issuer filings/exhibits via submissions history and direct archive
  documents. Uses a real identifying User-Agent, with no API key. Supports full
  UTC-day requests using filing dates, HTML/SGML/plain text and text-layer PDFs.
  Required unextractable or scanned PDFs fail without marking coverage. These
  records are corporate disclosures and retain that provenance, rather than
  being presented as independent journalism or precisely timed releases.

Provider references: [Benzinga News API](https://docs.benzinga.com/api-reference/news-api/get-news-items),
[Marketaux API](https://www.marketaux.com/documentation),
[Marketaux plans](https://www.marketaux.com/pricing).
Fixtures establish software behavior, not account entitlement, full historical
coverage or publication-time wording. Benzinga has not been live-tested.

## Small Marketaux live test

In `config/sources.json`, enable `marketaux`, set `symbols` to `["AAPL"]`, and
acknowledge the three verification fields after checking the provider terms and
mapping. Keep `pageSize: 3` for the free plan, and disable the other sources when
testing. Existing configurations without a Marketaux section continue to work.

In your PowerShell terminal, set the token for that terminal session only:

```powershell
$env:MARKETAUX_API_TOKEN = "YOUR_TOKEN"
npm.cmd run setup -- --db data/live-test.sqlite
npm.cmd run collect -- --db data/live-test.sqlite --sources marketaux --from 2026-10-16T14:00:00Z --to 2026-10-16T15:00:00Z
```

Repeat the collection command to verify `alreadyStored` instead of new insertions.
Use another narrow window if your plan does not cover this date. An unknown
history diagnostic means the supported archive boundary has not been verified.

This window was live-tested on 18 October 2026: 3 summaries were inserted, then
the same 3 were already stored on rerun. IDs, fingerprints and retrieval times
were unchanged. The token was used only in process environment variables and was
not saved in repository files. Wider historical coverage and rights are not
established by that test.

Inspect the database with a SQLite viewer:

```sql
SELECT article_id, title, published_at_utc, content_kind, content, retrieved_at
FROM articles
WHERE source = 'marketaux'
ORDER BY published_at_utc;
```

Synthetic Marketaux tests (no token or network needed):

```powershell
node --import tsx --test test/marketaux.test.ts
```

## Configure SEC or Finnhub

Both new sources are disabled in `config/sources.example.json`. Add the relevant
section to your local config while retaining its existing source settings. Keep
verification flags false until you have checked the configured scope. SEC has not
been live-probed. Finnhub AAPL access was verified with small read-only requests
on 19 October 2026; see the [local setup and command](tickets/SourceFinnhub.md#current-local-setup-and-running-collection).

For SEC, set `SEC_USER_AGENT` in the same terminal that runs collection to an
application name and your actual contact email. The example uses an explicit
Apple CIK; configure other symbols/CIKs as needed. No SEC API token or filing
submission account is required. Minimum spacing is 500 ms across metadata and
archive requests. Default forms are 8-K/6-K and amendments; `includeExhibits`
includes typed EX-99 documents. SEC supports whole UTC days only.

For Finnhub, set `FINNHUB_API_KEY` in the terminal. Enter a verified UTC
`historyFrom` in its config; an empty response alone does not verify historical
access. Minimum spacing is 1334 ms. `englishVerified` confirms a verified English
eligibility policy; the API response itself supplies no language guarantee.
These environment values are not loaded from .env files.

After configuring access and enabling the source:

```powershell
npm.cmd run collect -- --sources sec_edgar --from 2026-10-01T00:00:00Z --to 2026-10-02T00:00:00Z
npm.cmd run collect -- --sources finnhub --from 2026-10-01T00:00:00Z --to 2026-10-02T00:00:00Z
```

Choose dates inside the verified account coverage. Details and limitations:
[SEC](tickets/SourceSecEdgar.md), [Finnhub](tickets/SourceFinnhub.md).

## Collect and recover

```powershell
npm.cmd run collect -- --from 2026-10-01T00:00:00Z --to 2026-10-03T00:00:00Z
npm.cmd run collect -- --from 2026-10-01T00:00:00Z --to 2026-10-03T00:00:00Z --sources benzinga --continue-on-error --attempts 2
```

Ranges are publication instants `[from,to)` with explicit zones. They are split at
UTC midnight into at most one-day windows. Date-only records are eligible only
when the original request and the window cover whole UTC days. Precise records
use their UTC instant; the original source day, offset text and precision remain
separate. Missing title, valid day or usable content is rejected; missing author
is stored as NULL. HTML is converted to readable text without editorial rewriting.

Each source finishes enumeration before insertion. Each window commits in one
short transaction. JSON summaries show `fetched` (normalized records returned),
`inserted`, `alreadyStored`, shared-boundary `rejected`, and `completed`/`failed`/`skipped`.
Source-local diagnostics carry the same source/range and a `diagnostic` field.
Normalization events show `status`, `accepted`, `rejectedInvalid`, and `excludedRange`;
failures add a safe `error` code. These counters are separate from ingestion's
`rejected`. A failed fetch has `fetched: null`, not a successful empty count.
No provider response bodies, tokens or rejected prose are logged or archived.

Past full UTC days successfully collected for the same source and selection are
permanently covered, including successful zero-article days. Later runs skip the
source call and report `status: "skipped"`, `reason: "already_covered"`, and
`fetched: null`. Coverage is committed atomically with articles. Today, future days,
partial-day windows, failed retrievals, and boundary validation rejects do not
create daily coverage. Late additions to covered publication days are intentionally
excluded; there is no automatic refresh.

Changing the symbol selection starts independent coverage; changing symbol order,
credentials, or operational limits does not. Use `--force` to explicitly fetch a
covered day while preserving immutable article snapshots:

```powershell
npm.cmd run collect -- --sources marketaux --from 2026-10-01T00:00:00Z --to 2026-10-02T00:00:00Z --force
```

Existing article rows alone do not prove coverage. One successful full-day
collection establishes it after upgrading. Coverage survives restarts and backups.
See [the coverage pattern](tickets/SourceCollectorPattern.md#daily-coverage-avoiding-repeated-api-calls)
for source registration and selection/version rules.

By default a failed window stops later windows for that source; other enabled
sources still run. `--continue-on-error` tries later windows too. Any failed window
sets exit code 1. `--attempts` accepts 1–3 (default 1); only rate limits/transient
transport errors retry, with a short bounded delay. Caps fail visibly: narrow the
request or symbol list, or adjust limits, then rerun. There are no checkpoints.

Rerun the same range to recover: covered days are skipped and missing days fetched.
`(source, provider_article_id)` uniqueness keeps
the first successful snapshot, UUID, retrieval time and fingerprints unchanged.
Cross-source copies retain separate IDs and can be found using `text_fingerprint`;
compare actual text before declaring an exact copy.

## Develop a source

See [Adding an article source](docs/AddingSources.md) for the adapter structure,
shared helpers, a complete example, and testing/registration steps.
Each adapter contains provider mapping and explicit retrieval loops. Shared
`createCollector`, pagination guards, and content selection handle recurring work.
All factories accept injected transport, clock, sleep, and reporting for
synthetic tests. Public exports keep the range-only signature.

## Manual backup and restore

```powershell
npm.cmd run backup -- --output backups/articles-2026-10-18.sqlite
npm.cmd run restore-check -- --input backups/articles-2026-10-18.sqlite
```

Backup uses SQLite `VACUUM INTO` to create a consistent standalone copy, including
committed WAL data; it refuses an existing destination. Do not copy just the main
file of an active WAL database. `restore-check` copies the backup into an isolated
temporary directory, verifies schema and `integrity_check`, queries the article
count, and removes that temporary copy. It does not touch the live database.
To restore for use, stop all database users, copy a verified backup to a **new**
database path, and select that path with `--db`. Keep the previous database until
you have checked the restored data. No automatic backups are scheduled.

## Downstream use and limits

Future analyses reference `article_id` and `content_fingerprint`. Snapshot hashes
use JSON arrays of title, nullable author, original day, UTC time, precision,
original time text, content and content kind. Text hashes use content and kind.
Both use SHA-256. Publication time drives research/detection; retrieval time
records when the current provider snapshot was obtained.

Today's body may contain edits made after original publication. Historical work
must disclose this unverified snapshot assumption and possible look-ahead bias.
Prices, article revisions, story clustering, detailed job history,
scheduling, UI and the other platform blocks remain deferred.
