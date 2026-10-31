# Pure use cases

Apply guide sections 4-6; essential practices 4-6.

## Discover the contract

Identify the business decision, required inputs, output meaning, and observable effects. Preserve the approved contract and error semantics; the guide's sample scores and pipeline do not define product requirements.

## Separate decisions from effects

Extract deterministic calculations, validation and transformations from database writes, network calls and external state. Pass clock values, configuration or randomness explicitly when they affect a calculation. A pure function must neither mutate its inputs nor read hidden mutable state.

Let the use case orchestrate effects through narrow contracts. Define domain-required capabilities independently of SQL drivers or provider SDKs. Inject coherent service/repository groups, giving each use case only the capabilities it uses. Avoid both a global service locator and a long list of unrelated callbacks.

Repositories expose domain operations and their results/errors without leaking SQL rows, connection objects, ORM types or transaction internals into business contracts. Keep concrete implementations and their wiring at the technical/application boundary. Introduce an abstraction when it separates a real effect or responsibility; do not wrap every pure helper in an interface.

Keep each important function focused on one responsibility. Use `main.ts`, `types.ts`, colocated tests and private `helpers/` when that layout improves navigation; cohesion matters more than file size or a prescribed tree. Preserve established repository conventions where they already serve this purpose.

## Preserve operational semantics

During extraction, retain ordering, retry behavior and atomicity. Do not split a transaction merely to make functions look smaller. In Inquisitor, retrieval and persistence have separate responsibilities, first article snapshots remain immutable, and successful full-day coverage is committed atomically with article storage. Failed persistence must not be reported as successful collection.

Verify pure calculations against the contract and use injected doubles for external failures. Use relevant integration tests to confirm the real adapter still honors the contract. Report the separation achieved, affected effects and verification performed.
