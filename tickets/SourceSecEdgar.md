# B1-005 — SEC EDGAR disclosure source

Status: implemented and verified with synthetic fixtures; live access not probed  
Updated: 19 October 2026  
Contracts: [article ingestion](Block1Implementation.md), [collector pattern and coverage](SourceCollectorPattern.md)  
Companion: [Finnhub](SourceFinnhub.md)

## Objective and scope

`sec_edgar` collects issuer filings and relevant exhibits for configured companies.
These are corporate disclosures, not independent journalism. The collector returns
full extracted document text with issuer, accession, document identity, and time-basis
provenance. It uses the same ingestion, immutable snapshots, and daily coverage as
other sources.

This implementation adapts the supplied `SEC_Finnhub_Codex_Implementation_Spec.md`
to the existing TypeScript application. It adds no scheduler, revision tables,
extraction queue, raw-response archive, or independent database writer.

## Reading the implementation

| File | Responsibility |
| --- | --- |
| [`src/sources/sec-edgar.ts`](../src/sources/sec-edgar.ts) | Public wrapper, configured factory, issuer resolution, history traversal, required-document workflow, metadata mapping, and coverage selection |
| [`sec/submissions.ts`](../src/sources/sec/submissions.ts) | CIK normalization, recent/root-shaped history rows, safe archive paths and viewer-link unwrapping |
| [`sec/documents.ts`](../src/sources/sec/documents.ts) | Detail-table and SGML document discovery; HTML/plain-text/PDF extraction |
| [`test/sec-edgar.test.ts`](../test/sec-edgar.test.ts) | Offline provider/parser/extraction/coverage acceptance tests |

The public `collectSecEdgar(range)` loads source configuration internally.
`secEdgarCollector(config, runtime?)` supports injected JSON/byte transports,
clock, sleep, and reporting. It uses `createCollector`; persistence stays in common
ingestion. CLI registration is `configuredSource("sec_edgar", config.sec_edgar,
secEdgarCollector, 1, secSelection)`.

## Configuration and time semantics

The example is disabled. Enable only after verifying access, mapping, and English
eligibility for the configured universe. Configure:

- `auth: "none"`, `userAgentEnv: "SEC_USER_AGENT"`; the environment value must contain
  a real application/contact identity, with no newline. No SEC API key is required.
- `symbols`, with optional exact `ciks` overrides. Overrides are recommended for
  reproducible historical work. Otherwise resolve exact current tickers through
  SEC's ticker map; ambiguous/unresolved symbols fail.
- `forms`, defaulting to `8-K`, `8-K/A`, `6-K`, `6-K/A`; supported optional periodic
  forms are 10-K, 10-Q, 20-F, and 40-F, with amendments.
- `includeExhibits`, default true. Select primary documents and explicitly typed
  `EX-99`/`EX-99.*` exhibits; the exhibit type alone does not establish an earnings release.
- `requestIntervalMs`, at least 500 ms; `maxDocumentBytes` defaults to 25 MiB and
  `maxFilingBytes` to 100 MiB, within the common invocation byte budget.
- `maxPages` bounds metadata lookups, selected documents per filing, and PDF pages;
  `maxItems` counts discovered raw filing rows. `pageSize` is a retained common
  setting and is not sent as a SEC pagination parameter.

Only whole UTC-day ranges for modern filings (2000 onward) are supported. Filtering
uses SEC's calendar `filingDate`, stored at day precision. `reportDate` and raw
`acceptanceDateTime` remain provenance; neither is substituted for original release
or exact first public availability. `metadata.publicationBasis` is `sec_filing_date`.
Intraday filtering and automatic timezone repair are intentionally unsupported.
Timestamp conflicts are recorded as `not_assessed`, rather than falsely resolved.

## Retrieval and mapping

1. Resolve distinct configured symbols to CIKs and group shared-issuer securities.
2. Fetch each issuer's submissions JSON and parse parallel arrays without truncation.
3. Follow supplied overlapping history descriptors, including root-array histories.
   Unknown bounds are fetched conservatively. Unsafe filenames and inconsistent
   accession metadata fail. No sequential filename guessing.
4. Filter form and filing day. Accession overlap is deduplicated; amendments retain
   separate accessions.
5. Construct direct archive paths preserving valid subdirectories. Fetch the filing
   detail table to identify document types. `index.json` presentation types are not
   used as exhibit classifications. If needed, fall back to complete-submission SGML.
6. Download and extract every selected document, then accept its normalized record.
   Missing, oversized, empty, or unextractable required documents fail the entire day.

HTML extraction removes scripts, styles, hidden inline-XBRL and hidden elements,
while preserving visible text and table rows/cells. Plain text and SGML wrappers
are supported. PDF.js extracts text-layer PDFs; empty/scanned PDFs fail explicitly
with `OCR_REQUIRED`. OCR and non-text attachments are not silently substituted.

Identity is `CIK:accession:document-relative-path`. Each primary/exhibit document is
separate, related by its accession in metadata. The issuer is `originalPublisher`;
SEC is the channel. Missing titles receive a labeled synthetic title flag. Stored
metadata includes symbols, form, dates, acceptance raw text, document selection,
SHA-256 checksum, extraction method/status, and mapping basis. The collector does
not claim that an exhibit is independent reporting or a verified press-release time.

A bounded instance-local cache reuses closed-day metadata across daily windows in
one manual run. It is not a durable mapping cache or a completion checkpoint. JSON
and document requests share the invocation byte budget and pacing across both SEC
hosts. Multiple processes are not coordinated.

## Shared coverage and failures

`secSelection` contributes normalized CIK overrides, forms, exhibit choice, and
fixed time/mapping/extraction policy versions to coverage. Symbol order and
operational limits do not change coverage. Bump registration/policy version when
eligibility, extraction, or mapping semantics change. Changes to SEC's current
mapping are not detected on already covered days; use explicit CIKs or force refresh
when deliberately changing the universe.

Past full days with documents or zero eligible filings are permanently covered
only after successful collection and atomic persistence. Today and partial days
do not become covered. Failures leave no new coverage. `--force` refreshes without
overwriting first snapshots. Late filings/corrections are intentionally missed
once a day is covered, following the approved project assumption.

The shared transport rejects redirects and returns safe typed failures. Short
Retry-After values are honored by bounded whole-window retries; waits above one
minute require a later manual run. No additional per-request retry loop exists.

## Verification and operating gate

Synthetic tests cover primary/exhibit mapping, main/history shapes, missing fields,
CIK grouping and ambiguity, traversal/viewer links, amendments, SGML fallback,
hidden content/tables, required-document failures, caps, coverage, persisted
metadata, real PDF text extraction, and OCR-required failures.

Before live use, supply the real User-Agent and verify representative issuer formats
and permitted use. No SEC probe was run with an invented contact identity. Deeper
archives, precise acceptance-time mode, automatic conflict reconciliation, durable
mapping caches, OCR, and separate extraction resumption are future scope.

References: [SEC public APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces),
[archive/reference and fair-access conventions](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data),
[Webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions),
[Form 8-K](https://www.sec.gov/files/form8-k.pdf).
