# Domain contracts

Apply guide sections 7-8; essential practices 7-9.

## Choose an authoritative contract

Inspect existing types, schemas, validation and consumers. Establish one owner for each shared contract and identify any persisted or externally consumed representations.

Use TypeScript for small internal types and language-specific advanced types. For principal domain entities genuinely shared between languages, consider JSON Schema as the source of truth and generate TypeScript/Python representations as needed. Do not introduce Python, a generator or schemas solely because the guide illustrates them; Python remains a proposal in the project plan.

## Specify meaning as well as shape

Define required fields, units, permitted values, missing versus null semantics, identity, time precision and failure results where relevant. Do not turn missing answers into neutral values or invent a numeric scoring scale.

In Inquisitor, preserve stable source identity, immutable stored text, content fingerprint, retrieval time, original publication time and its precision. Keep analysis definition/version and input provenance traceable when working on analysis contracts. Changes must not silently reinterpret stored research inputs.

Keep public types available through the owning module's public API. Avoid imports of internal adapters or driver types. Check consumers and stored-data compatibility when changing required fields or semantics; include migration/version handling only where the change needs it.

## Align runtime and generated representations

Validate untrusted external inputs at an appropriate boundary: static types alone cannot validate JSON or provider responses. Ensure schema constraints and runtime acceptance agree. Preserve useful language-specific types or metadata without weakening the underlying validation contract.

When generation exists, edit the source schema and generator inputs, then regenerate. Never hand-edit generated output. Verify reproducibility and drift using existing project commands; introduce a generation/drift check only within the requested work. Do not assume the repository already has `typegen`.

Run type checking and focused behavioral validation for changed contracts. Report the authoritative source, compatibility impact, generation performed and checks run. Clearly identify design proposals that remain unimplemented.
