# Behavioral testing

Apply guide sections 9 and 12; essential practice 10 and the unit/integration levels of the five-level strategy.

## Derive the oracle independently

Read the task's specification or ticket. Inspect the public API and contracts before relying on implementation details.

Write down expected observable outcomes from requirements. Resolve contradictory expectations against the approved business contract; do not bless current behavior simply because the code produces it. Do not adopt the guide's illustrative 1-5 score range as a product requirement.

Cover nominal behavior, meaningful boundaries, invalid inputs and relevant external failures. Prefer assertions about outputs, persisted state and visible errors. Assert interaction order or call counts only when the contract makes them meaningful. Avoid snapshots of internal structure and tests that repeat the production algorithm.

## Choose the level that proves the behavior

Use focused unit tests for pure rules and transformations. Inject doubles for network, model, storage and clock dependencies; test rejected responses and persistence failures as appropriate. Add integration tests when real adapter behavior, SQL constraints, transactions or module collaboration determine correctness.

For affected Inquisitor collection behavior, useful contract examples include:

- Recollection preserves the first snapshot and stable source identity.
- A successful past full UTC day, including a zero-article day, can establish coverage for the same source and selection.
- Today, partial days and failed windows do not establish daily coverage.
- Article storage and coverage are atomic; stored article rows alone do not prove coverage.

Choose examples relevant to the change rather than rerunning every scenario for unrelated edits. Keep fixtures deterministic, databases temporary and external integrations controlled. Do not make paid/live provider requests merely to exercise tests.

## Execute and assess

Inspect current `package.json` before choosing commands. At skill creation, Inquisitor uses `npm test` for `tsx --test test/*.test.ts` and `npm run check` for TypeScript. Follow current scripts if they change; run focused tests first when useful, then required checks.

The guide's complete strategy also includes mutation, contract-based incorrect implementations and architectural checks. Apply those when relevant to the task or criticality; a documentation edit does not require all five levels. Passing tests establish only the behavior they actually exercise. Report checks run, failures, omissions and any unresolved ambiguity in the expected result.
