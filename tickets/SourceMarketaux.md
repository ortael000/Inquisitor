# Marketaux article collection

Status: implemented; small live collection and rerun verified on 18 October 2026.

### Quota exhaustion during historical collection

On 19 October 2026, the historical backfill completed 1–4 January (49 stored
articles) and failed on 5 January after accepting 21 candidates in memory.
A subsequent metadata probe returned HTTP 402 with `usage_limit_reached`,
confirming that the account quota was exhausted at diagnosis time. The original
generic `INCOMPLETE` log alone did not establish the specific failing response.
Transport now recognizes that bounded HTTP 402 error payload as non-retryable
`RATE_LIMIT`; unknown 402 payloads remain `INCOMPLETE`. Regression tests cover this
mapping, safe errors, and bounded error bodies.

Failed days save neither partial articles nor coverage. Check the provider account
for quota renewal or a larger allowance, then rerun the original command without
`--force`: completed days are skipped and 5 January is retried in full. Increasing
page/item limits or retry attempts does not increase the provider quota.

Refactored on 19 October 2026 to [B1-004's shared collector pattern](SourceCollectorPattern.md).
The internal `marketauxCollector(config, runtime?)` factory now supports synthetic
transport, clock, sleep, and reporting injection. The public range-only function
is unchanged. Shared helpers own acceptance, pacing, budgets, and diagnostics;
the adapter retains query construction, metadata checks, mapping, and provider errors.

Added as a free-plan testing source at the user's request. The public function is
`collectMarketaux(range): Promise<NormalizedArticle[]>`; it loads configuration and
credentials inside the source module. No configuration/factory argument is needed.

Mapping:

| Shared field | Marketaux field |
| --- | --- |
| `source` | `marketaux` |
| `providerArticleId` | `uuid` |
| `title` | Cleaned `title` |
| Publication fields | `published_at`; original timestamp text retained |
| `content`, `contentKind` | Usable `description`, otherwise `snippet`; always `summary` |
| `originalPublisher` | Source domain from `source`, without inferring syndicated authorship |
| `url`, `language` | Provider URL and language |
| `author` | Omitted; this response does not establish an author |

The connector requests English content for each configured ticker separately,
disables provider story grouping, and checks one-based page metadata. It only
returns after complete enumeration. Hard item/byte/page limits and the provider's
20,000-result cap fail visibly. Shared ingestion owns UUIDs, fingerprints,
retrieval time and immutable first-snapshot storage.

Free-plan defaults are 3 records/page, 30 pages and 90 candidates per window.
Use narrow publication ranges to stay within quota. Credentials are supplied via
`MARKETAUX_API_TOKEN`, never configuration JSON or response archives.

Live verification used AAPL over `[2026-10-16T14:00:00Z,2026-10-16T15:00:00Z)`:
3 summaries inserted, then 0 inserted / 3 already stored. Saved article IDs,
fingerprints and retrieval times remained unchanged. No raw provider responses
or token were saved. This test does not establish wider history, publication-time
wording, or licensing/retention rights.

Sources: [API documentation](https://www.marketaux.com/documentation),
[pricing](https://www.marketaux.com/pricing). See [README](../README.md) for commands
and `test/marketaux.test.ts` for synthetic query, pagination, mapping, limits,
failure and ingestion tests.
