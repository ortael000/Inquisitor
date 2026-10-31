# Financial Intelligence Platform

*High Level Design and Detailed Design Brief*

Version 0.9  |  18 October 2026

This document defines the business purpose, four functional blocks, shared principles, and boundaries of a platform that combines text analysis with market history to support investment research. It provides the common brief for five subsequent design documents: one global architecture and one detailed design for each block.

**Intended outcome:** Build a reliable research and review workflow that can surface potential long and short opportunities for manual assessment. Predictive performance is an experimental research result; it is not a software acceptance criterion.

### 1 Purpose and initial scope

The user selects sources and processing ranges, runs independent analyses, studies relationships with subsequent market movements, and reviews situations that match selected patterns. Every investment decision and market action remains manual.

| Dimension | High level direction |
| --- | --- |
| Initial market | Mainly Nasdaq technology equities. Exact universe and selection rules are defined during detailed design and configuration. |
| Asset coverage | Individual shares and ETFs; indices can serve as market references or research targets. An ETF is a traded fund, distinct from an index. |
| Excluded initially | Cryptocurrencies, foreign exchange instruments, and commodities. Derivatives and options are not established as requirements. |
| History and language | Initially two to three years, extendable through configurable ranges. English first, with provision for additional languages. |
| Operating model | Local operation first; Blocks 1, 2, and 3 are launched separately to refresh their outputs; Block 4 scans stored results without triggering upstream work. |

The next design work focuses on Blocks 1 and 2. Blocks 3 and 4 remain defined at the level needed to preserve compatible inputs, reusable outputs, and clear responsibilities.

## 2 Global functional architecture

The four blocks share a common data foundation and operational services. They remain separate business responsibilities within a modular application; they do not require four independent services or databases.

| Block | Business responsibility | Persistent output |
| --- | --- | --- |
| 1 Collection | Collect and normalize text and market prices through selectable source functions. | Common content dataset, price history, provenance, stored article snapshots, and collection status. |
| 2 Content analysis | Run independently defined analyses on eligible text. | A dedicated result table for each analysis type, with evidence and version history. |
| 3 Research | Discover and validate patterns; store reusable definitions and research evidence. | Datasets, experiments, pattern versions, and validation results. |
| 4 Detection | Read stored outputs from Blocks 1, 2, and 3, filter recent observations, and propose market opportunities. | Explained opportunities, scan status, and manual review history. |

### Data flow and boundaries

- Block 1 stores normalized content and prices for downstream use. Block 2 reads content; Blocks 3 and 4 may read relevant stored prices.

- Block 2 produces observations grounded in the supplied content. It does not use market prices or subsequent market outcomes.

- Block 3 discovers and validates patterns using stored observations and market outcomes. It publishes versioned patterns, required inputs, evaluation definitions, and evidence.

- Block 4 reads already stored content, prices, analysis results, and patterns. It evaluates recent situations without launching collection, content analysis, or research jobs.

- Shared feature definitions and preprocessing support both historical research and recent detection. Block 4 must not recreate them independently.

### Two user workflows

**Historical research:** Collect a chosen historical range, run missing analyses, construct a research dataset, investigate relationships, and evaluate candidate patterns.

**Recent review:** Manually refresh Blocks 1, 2, and 3 when needed. Separately launch Block 4 with a market scope and recent window. It uses available stored outputs and returns opportunities or explicit data-readiness findings.

The platform records what was processed, with which versions and data, and what remains missing. A failed or incomplete evaluation must remain distinguishable from a completed evaluation with no match.

## 3 Block 1 Collection and normalization

### Business objective

Provide a consistent, traceable body of text and market history from independently selectable sources. Adding a source should not require redesigning downstream analyses.

### Collection model

Each configured source function accepts only a date or time range and returns normalized records after handling its own source-specific settings, credentials and safe findings. A separate common ingestion command validates and stores the results. For the article-collection MVP, it processes small windows and reports status in command output; rerunning a range skips successfully covered past full UTC days for the same source and selection, including zero-article days. Article uniqueness preserves first snapshots on refetch. A small daily coverage table is persisted; detailed run/checkpoint tables are deferred. Retrieval and database persistence have distinct responsibilities.

A parallel family of functions collects market prices for selected instruments and intervals, initially supporting hourly research where coverage permits. An enabled Yes or No setting controls source selection when the user launches Block 1. This block owns refreshing external data; Block 4 never invokes its collectors. Access and coverage are defined in the Block 1 detailed design.

### Common information requirements

- Content: source and original publisher, source identifier or URL, title, author or account where available, publication time or date and its precision, language, text or summary, completeness, and retrieval time.

- Traceability: stable identity, source settings, time of retrieval, duplicate or related-story evidence, and quality findings. The article MVP stores stable IDs, retrieval time and exact-text fingerprints in one table; durable run and relationship records are later work.

- Prices: stable instrument reference, provider, interval and resolution, price values, currency, adjustment convention, and correction history.

Missing information remains explicit. The platform does not invent precise timestamps, authors, or full text. Date-only records remain usable for research over days; uncertain intraday ordering must not be fabricated.

### Stored article snapshot and repeated information

For the initial implementation, collect the article text currently returned by the source and store one immutable snapshot per source article with its original publication time. The user assumes later edits are usually minor and do not change the main message; this is an unverified research assumption, not a measured property of the selected news providers. Recollection of an already stored source article does not replace its snapshot or create another article row. Record when the snapshot was retrieved so historical research does not mistake today's text for verified publication-time wording. Tracking article updates and reconstructing earlier versions are deferred.

Copies of the same article must not inflate the apparent number of independent observations. The article MVP preserves separate source identities and exact-text fingerprints; it does not create duplicate relationship tables or weighting rules. Related reporting and source-diversity weighting remain later research decisions.

### Required result

Repeated or rerun collection does not create duplicate source identities. The MVP prints per-window success, skips, already stored items and failures. A small coverage table records successful past full UTC days by source and selection, including zero-article days, atomically with article storage. Covered days do not expire; later additions to their publication day are intentionally excluded unless an explicit force refresh is requested. Today, partial-day windows and failed collections do not establish daily coverage. Existing article rows alone do not prove coverage. Detailed operational history remains later work. Old and recent ranges use the same functional contracts.

## 4 Block 2 Independent content analyses

### Business objective

Convert normalized text into structured observations that can be combined in research. Each analysis has a defined purpose, accepted inputs, business meaning, output structure, and its own dedicated result table.

### Flexible analysis portfolio

Possible analyses include entity and topic classification, target-specific sentiment, outlook extraction, business events, uncertainty, and relationships explicitly expressed in the text. These are examples. The initial analyses and their sequence are deferred to the Block 2 detailed design.

Each analysis defines its own semantics. Positive language, a favorable business development, and an expected market movement are different concepts; no common sentiment definition or numeric scale is approved here. Outputs must be comparable only where their definitions support comparison.

### Processing principles

- Select content eligible for the analysis, considering language, completeness, time precision, and other declared input requirements.

- Process work without a successful result for the same stored article snapshot/content fingerprint, analysis version, and relevant configuration or model identity.

- Track completion separately for every analysis. Success in one analysis does not mark the article complete for all other analyses.

- Preserve previous results when prompts, models, or definitions change. A future explicit snapshot replacement policy would also require preserving prior analysis inputs. Failed work remains identifiable and retryable.

- Keep evidence and explanations grounded in the exact stored text and its fingerprint. Missing answers must not be converted into neutral observations.

### Reference data and output requirements

Prefer established sector taxonomies and market reference lists where suitable, so classifications can be mapped to external datasets. The chosen standards, identifiers, entity-resolution rules, and governance are deferred.

Each result identifies its source article and stored content fingerprint, analysis definition and version, model or method where applicable, processing run, status, and supporting evidence. Dedicated tables may include related child records. The user launches Block 2 separately; Block 4 reads its saved results and never requests missing analyses automatically.

### Boundary and quality

Content analysis does not consult market prices or later outcomes. External content is untrusted input and must not change execution instructions. Detailed design will establish validation, treatment of difficult inputs, any dependencies between analyses, and a quality-review approach.

## 5 Block 3 Pattern discovery and evaluation

### Business objective

Investigate relationships between content observations and subsequent market outcomes. Retain reusable patterns as explicit rules, statistical relationships, or fitted models.

### Research workflow

The user selects scope, periods, observations, features, outcomes, and settings. The block builds traceable datasets and evaluates candidates on later data excluded from development. Evaluation addresses overlapping outcomes, repeated hypothesis testing, and declared baselines; unsuccessful experiments are retained.

Features may include independent-story counts, source diversity, target-specific scores, outlooks, and events. Define how repeated stories, missing observations, and time precision affect each feature. Article-edit deltas are not available from the initial stored snapshots.

### Timing and historical assumptions

Initially, the currently retrieved snapshot is analyzed as if it represented the article at its original publication time. Historical research will not simulate configurable collection or analysis delays. This snapshot assumption is explicit and unverified; it is not evidence of the exact wording or information available to a real user at publication time.

Date-only records can support daily trends. Any intraday use requires an explicit treatment of uncertain availability. Future market outcomes must not enter historical features.

Where AI contributes, restrict inputs and evidence to the relevant cutoff and prevent browsing for later facts. Disclose residual model-knowledge limitations: text-only instructions cannot prove that a model has no later knowledge.

### Reusable pattern requirement

Every pattern offered to Block 4 must specify its version, target and related entities or instruments, source requirements, analyses, features, lookbacks, price requirements, missing-data rules, horizon, evaluation evidence, and limitations. These dependencies let Block 4 check stored inputs and evaluate recent situations consistently.

### Reuse for recent evaluation

Block 3 stores reusable rules or model artifacts and their preprocessing definitions. Block 4 may use shared calculation helpers to score stored recent inputs, but it does not launch Block 3 jobs. The user separately launches research updates when needed; a scan does not rediscover patterns, retrain models, or change thresholds.

### Decisions deferred to detailed design

Entity-to-instrument mapping, forecast targets and horizons, price and benchmark conventions, research methods, validation thresholds, pattern selection, and any hypothetical long or short trade evaluation remain open. Listed companies, shares, ETFs, and relevant indices are the initial focus.

## 6 Block 4 Opportunities from stored recent data

### Business objective

Read the outputs already produced by Blocks 1, 2, and 3, examine recent observations, and propose potential long or short opportunities. This block owns detection and presentation. Collection, content analysis, and research updates remain separately launched by the user.

### Starting inputs

The user supplies a number of recent days, an evaluation cutoff, and optionally a market, company, instrument, or group. A two-, three-, or four-day window is an example, not a fixed limit. Pattern eligibility and calendar versus trading-day conventions are defined in detailed design.

### Detection sequence

- Select applicable stored pattern versions and their related targets, required observations, price inputs, features, and analysis versions.

- Read available stored content and prices from Block 1, saved observations from Block 2, and patterns and validation evidence from Block 3.

- Filter observations to the selected recent period. Use content publication time and price observation time, with explicit handling of date-only or unknown dates. A new retrieval or analysis timestamp does not make an old article recent.

- Check freshness, completeness, versions, and required history. Missing or incompatible inputs produce a readiness finding; they do not trigger upstream processing.

- Apply the stored rules or models using shared feature definitions, group matches, and save explained opportunities and scan status for manual review.

### Example involving Nvidia

For Nvidia and the last three days, Block 4 finds relevant saved patterns, reads stored recent observations and prices for Nvidia and declared related targets, and evaluates available evidence. If a required analysis is missing, it reports the gap. The user can later run the relevant upstream block and repeat the scan.

### Data readiness and review output

The recent filter applies to observations, not the age of the stored pattern. Longer required history must be satisfied by a wider selected window or explicitly permitted stored context; otherwise report insufficient data. Nothing is fetched automatically. Results describe stored-data freshness and must not imply coverage of all currently available external information.

Each opportunity shows its target, direction, horizon, pattern version, input cutoff, evidence, matched features, signal meaning, and historical evaluation. Repeated scans retain history without duplicate proposals. Detailed design defines modular selection, filtering, checks, scoring, and presentation, including conflicts and expiry. No broker integration or order execution is included.

## 7 Shared principles and design assumptions

### Common data foundation

The platform maintains common normalized content, price history, dedicated analysis results, research records, reusable patterns, opportunity records, and operational history. Logical separation supports clear ownership without requiring physically separate databases.

Stable references, explicit missing values, preserved time precision, versioned analysis definitions, and a fingerprint of the immutable stored article snapshot connect results to their inputs. Normalize precise timestamps to UTC while preserving source time information. If article snapshot replacement is introduced later, it must not silently replace historical inputs used by saved experiments or detections.

### Operation and portability

Blocks 1, 2, and 3 are launched manually and independently when their outputs need refreshing. Compatible completed work is reused. Block 4 scans stored outputs without triggering these jobs or changing their results. The initial article MVP reports progress/errors by window and resumes by rerunning a requested range; more granular persisted job recovery is deferred.

Local operation should remain portable to a server. Credentials stay outside code and reports. Collection, processing, retention, and export must respect applicable source constraints. Detailed design defines backup, recovery, concurrency, security, and artifact retention.

### Proposals retained for architecture review

TypeScript/Node.js and SQLite are approved for the initial local Block 1 article-collection milestone. PostgreSQL for broader structured data, Python for numerical research, a replaceable AI-provider interface, and local files for larger artifacts remain proposals for architecture review. Future deployment needs may revise the database choice.

The previous indicative monthly envelope of USD 100–200 remains a planning reference. Included costs, initial historical-processing allowance, source subscriptions, and enforcement rules require confirmation. The high-level design does not promise specific coverage within that envelope.

### Assumptions requiring future review

| Assumption or constraint | Design consequence |
| --- | --- |
| Today's retrieved article snapshot represents its original publication-time message | Record original publication time, actual retrieval time and content fingerprint. The assumption that edits are usually minor is unverified; original wording and earlier versions cannot be reconstructed from one current snapshot. |
| No simulated collection or analysis delay | Label historical outcomes under this assumption; do not describe them as demonstrated live execution results. |
| English first and two to three years initially | Keep language and date ranges configurable; longer history and other languages need compatible collection and analysis support. |
| Independent information matters more than repeated copies | Preserve origin and duplicate/story relationships; define diversity methods in detailed design. Article-edit deltas are unavailable initially. |

## 8 Brief for the five detailed design documents

The design agent must produce the five documents below from this shared baseline. It must preserve confirmed decisions, identify proposals as proposals, and record unresolved choices with an owner and decision point. It must not silently turn an unanswered review question into an approved requirement.

| Document | Required responsibility | Key handoff |
| --- | --- | --- |
| DD0 Global architecture | Independent block execution, shared data and read contracts, provenance, versioning, operations, deployment, security, budgets, and technology decisions. | Common architecture and interface baseline for all four blocks. |
| DD1 Block 1 | Source feasibility, enabled flags and capabilities, collector and ingestion contracts, content and price models, single article snapshots, duplicates, quality, coverage, recovery, and tests. Its article MVP uses an articles table, a small daily coverage table, and rerun-based recovery; fuller operations and prices follow. | Reliable normalized data and provenance for analysis and research. |
| DD2 Block 2 | Analysis registry, selected analyses and meanings, input eligibility, dedicated schemas, evidence tied to stored content fingerprints, incremental processing, model use, validation, and tests. | Versioned analysis observations and their reference-data requirements. |
| DD3 Block 3 | Entity and instrument mappings, discovery and validation, features, temporal rules, pattern lifecycle, saved artifacts, and shared evaluation definitions. | Reusable stored patterns, declared inputs, and evaluation evidence. |
| DD4 Block 4 | Stored-data selection, recent-day filtering, optional market scope, readiness checks, pattern scoring, consolidation, explanations, review output, and tests. | Traceable opportunities and scan status without upstream execution. |

### Common structure required in each document

Include purpose and scope; confirmed requirements and open decisions; responsibilities and dependencies; workflows; inputs and outputs; logical and physical data design where relevant; processing and versioning rules; error and recovery behavior; configuration; acceptance criteria; and a phased implementation backlog.

### Cross document consistency

Use one glossary and shared requirement identifiers. Assign one authoritative owner to every contract, and reference it elsewhere. Changes to input meaning, identity, time rules, or pattern semantics must update every affected document. Examples should illustrate contracts without implying that source access or predictive evidence has already been established.

## 9 Design sequencing and acceptance

### Recommended design sequence

Begin with DD0 to establish minimum shared contracts, then develop DD1 and DD2 as the immediate priority. Produce DD3 and DD4 against those contracts, resolving their open business choices when those blocks are designed. Return any cross-block changes to DD0 and the affected upstream design.

Foundational identity fields, snapshot fingerprints, retrieval time and publication precision must be supported in Blocks 1 and 2 even though detailed company-to-instrument resolution and research use are finalized later. This avoids making later mapping decisions a reason to discard collected evidence.

### Deferred decision register

| Owner | Decisions to resolve |
| --- | --- |
| DD0 | Operating system and hardware; technology approval; deployment and access; budget coverage; recovery and retention; shared interfaces and change control. |
| DD1 | Initial sources and access; exact universe selection; content types and partial-content eligibility; price coverage and provider conventions; duplicate detection mechanics. Article update tracking is deferred. |
| DD2 | Initial analyses; meanings and scales; quality review; long or difficult inputs; AI provider and privacy; language handling; taxonomy selection and analysis dependencies. |
| DD3 | Entity and instrument mapping; source-diversity weights; horizons and outcomes; temporal evaluation under the snapshot assumption; baselines; statistical validation and pattern approval. |
| DD4 | Optional scope and pattern eligibility; day and cutoff semantics; uncertain dates; stored context; freshness and missing-data status; repeated scans, ranking, conflicts, expiry, and review. |

### Functional acceptance for the project

- Collect selected ranges into consistent content and price datasets, with identifiable coverage, stored snapshot retrieval times, and errors; repeat or resume without duplicate identities.

- Run selected analyses into their dedicated tables, process only missing eligible work for the chosen versions, and preserve evidence and prior results.

- Reproduce a research dataset and its evaluation from recorded inputs and definitions; preserve unsuccessful experiments as valid research results.

- Scan stored outputs for a chosen recent window; apply saved patterns with shared definitions and required stored prices; explain matches and missing inputs without launching any upstream block.

- Demonstrate the end-to-end workflow with a suitable test pattern even if research has not discovered a useful predictive relationship. Test rules are identified as test data and are not presented as validated investment signals.

Predictive value and possible long or short use are assessed experimentally after the functional workflow is working. Detailed acceptance tests measure correct behavior, traceability, and reproducibility rather than a promised market return.
