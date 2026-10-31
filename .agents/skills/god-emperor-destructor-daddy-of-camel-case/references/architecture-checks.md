# Architecture checks

Apply guide sections 12-13; essential practice 13 and the architectural level of the five-level test strategy.

## Identify the enforceable invariant

Inspect actual module boundaries, TypeScript configuration, package scripts, aliases and CI before selecting a checker. The guide's example `src/core`, `libs` and `apps` tree is not evidence those directories exist here.

Agree on a concrete allowed dependency rule from the intended architecture. Map existing files to roles. Separate pre-existing violations from regressions introduced by the requested change; avoid turning a small enforcement task into a full repository migration.

## Match the check to the rule

| Invariant | Suitable evidence |
| --- | --- |
| Core independent of technical libraries/apps | Resolved import graph and allowed-layer rules |
| No new dependency cycles | Cycle detection over relevant modules |
| Consumers use public APIs | Import restrictions covering module internals |
| Contracts type-check | TypeScript compilation with project settings |
| No unjustified explicit `any` | Appropriate lint rule or focused review; strict mode alone does not prohibit explicit `any` |
| Generated types match authoritative schemas | Reproducible generation and drift check, if generation exists |
| Tests execute successfully | Actual test command and failure propagation in CI |

Prefer established tooling. When adding a checker is in scope, resolve imports using the project's module semantics, including relative paths, aliases and NodeNext `.js` specifiers targeting TypeScript. Make an explicit choice about type-only edges and dynamic imports. Do not claim a regex search proves the absence of cycles or forbidden resolved dependencies.

Verify a new check with an allowed example and a deliberately forbidden example in disposable fixtures. For cycle checks include a multi-hop cycle; for public APIs distinguish internal same-module imports from cross-module access. The checker must exit unsuccessfully on violations and produce actionable file/edge diagnostics.

## Integrate within scope

Add scripts or CI wiring when requested or needed to complete the enforcement task. Preserve existing unrelated configuration. Do not invent mutation, lint, typegen or CI commands that the repository does not provide. Inquisitor initially provides `npm run check` and `npm test`; inspect current scripts before using them.

Keep module documentation and exports consistent when the enforced boundary changes. Run the check against real code after fixture validation, plus affected required checks. Report automated coverage, manual-only findings, exceptions and unresolved violations. Documentation of a rule alone does not establish automated enforcement.
