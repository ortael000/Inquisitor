---
name: god-emperor-destructor-daddy-of-camel-case
description: Apply the god-emperor-destructor-daddy-of-camel-case development guide to modular design, domain contracts, behavioral testing, mutation testing, and architecture enforcement. Use for implementation or reviews following this guide, loading only the relevant topic references.
---

# god-emperor-destructor-daddy-of-camel-case development practices

Apply the guide's 14 practices through the topic references below. These are parts of this single skill, not separate skills.

## Shared workflow

In Inquisitor, read `.agents/memory/ProjectPlan.md` and relevant project memory before work. Consult root-level `guide_destructor_daddy.md` for the original rationale. The product plan governs business scope; the guide supplies engineering recommendations. Repository paths in references are relative to the project root.

Identify the affected module, read its public API and contracts, inspect implementation as needed, then read relevant tests. Make the smallest coherent change and run checks appropriate to its behavior and risk. Preserve the user's task scope and authorization.

Treat the guide's directory tree, score scale, pipeline and technologies as examples. Prefer cohesion over file count, abstractions for real boundaries, and JSON Schema/generation where shared contracts justify them. A local fix does not require a repository-wide migration or every testing level.

## Select references

Read only the topics needed for the current task; combine them when work spans responsibilities.

| Task | Reference | Essential practices |
| --- | --- | --- |
| Design/refactor boundaries, dependencies, public APIs or module documentation | [Modular architecture](references/modular-architecture.md) | 1-3, 9, 14 |
| Separate business decisions from effects; inject services/repositories | [Pure use cases](references/pure-use-cases.md) | 4-6 |
| Define types, runtime validation or shared schemas | [Domain contracts](references/domain-contracts.md) | 7-9 |
| Verify important behavior, boundaries, errors and adapter collaboration | [Behavioral testing](references/behavioral-testing.md) | 10; unit/integration levels |
| Challenge tests with plausible bugs in critical rules or requested quality reviews | [Mutation test quality](references/mutation-test-quality.md) | 11-12 |
| Enforce imports, layer rules, cycle restrictions or generated-contract consistency | [Architecture checks](references/architecture-checks.md) | 13; architectural test level |

For implementation, select the relevant design/contract topics and apply behavioral testing when the change warrants it. Load mutation guidance for requested test-quality work or critical rules needing stronger evidence. Load architecture-check guidance when reviewing or implementing automated enforcement.

## Completion

Report the behavior or boundary changed, relevant checks actually run, and material remaining gaps. Distinguish implemented checks from proposals and manual inspection. Passing tests or a high mutation score do not prove complete correctness.
