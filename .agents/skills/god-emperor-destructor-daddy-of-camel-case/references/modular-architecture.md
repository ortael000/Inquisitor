# Modular architecture

Apply guide sections 1-3, 8, and 13; essential practices 1-3, 9, and 14.

## Establish the boundary

Identify the affected responsibility, callers, owned data, and existing public contract before proposing folders. Read the module's public entry point, contracts, implementation as needed, then its tests. Existing files may serve as modules; absence of `src/core` does not itself require a migration.

Classify responsibilities by role:

| Role | Owns | Allowed dependencies |
| --- | --- | --- |
| Core | Domain models, rules, use cases, service contracts | Domain contracts; justify third-party additions |
| Libraries | Database, provider, HTTP, UI and other technical implementations | Core and other libraries through public APIs |
| Applications | CLI, API, worker or UI composition | Core and libraries; no direct app-to-app dependencies |
| Scripts | Generation, migrations and maintenance | Modules needed for the script's task |

Keep concrete database drivers, provider SDKs, HTTP and UI implementations outside the Core. A core use case can orchestrate effects through injected contracts. Avoid cycles; repair ownership or extract a coherent shared contract rather than hiding cycles behind re-exports.

## Implement a bounded change

Give each module one coherent responsibility and an intentional public API, conventionally `index.ts` for directory modules. Consumers use this API instead of importing internal helpers, SQL or drivers. Export only supported capabilities. Resolve naming collisions before adding ambiguous re-exports.

Preserve behavior during refactoring and move only what the task requires. Do not impose the example tree, split every function into a folder, or create four services/databases for the four product blocks. In Inquisitor, collection, content analysis, research and detection remain distinct responsibilities: analysis does not use market outcomes, and detection reads stored outputs without launching upstream work. Example scoring scales and portfolio models in the guide are not approved product requirements.

When useful, add or update a short module README describing responsibility, public functions, dependencies, allowed collaborators and local conventions. Keep it consistent with actual exports.

## Verify and report

Check affected callers, type compatibility, behavior and dependency direction. Use existing architecture checks when available; distinguish automated evidence from manual inspection. Report the resulting boundary, important compatibility decisions, checks run and remaining violations outside scope. Do not describe a partial migration as full architectural compliance.
