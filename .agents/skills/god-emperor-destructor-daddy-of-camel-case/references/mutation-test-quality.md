# Mutation test quality

Apply guide sections 10-12; essential practices 11-12.

## Establish a valid baseline

Read the expected public contract independently of the implementation, consulting the relevant requirements or tickets.

Select a bounded target such as validation, scoring, data transformation or coverage eligibility. Run the unchanged relevant suite first. Investigate a failing baseline before interpreting mutation results. Preserve user changes; use a disposable copy or a tool's isolated sandbox for intentionally broken implementations. Never run mutants against live databases or provider accounts.

## Implementation-derived mutation

Use existing mutation tooling if configured. Inspect installed tools and scripts rather than assuming a runner exists or adding an entire framework for a small review. Otherwise a few isolated, targeted variants can provide useful evidence; describe this as a manual experiment rather than a full mutation campaign.

Introduce plausible faults such as inclusive/exclusive boundary changes, AND/OR substitution, arithmetic changes or removed failure propagation. A mutant is killed only when an applicable test fails because of the changed behavior. Compilation errors, runner crashes, timeouts and unexecuted mutants must be reported separately from meaningful assertion failures.

For each survivor, determine whether a requirement is untested, the mutation is equivalent, or the target is unreachable. Improve tests from the contract; do not change the specification merely to kill a mutant. If reporting a score, disclose the denominator and exclusions: killed relevant mutants divided by relevant assessed mutants. Treat no assessed mutants as unavailable, not 100 percent.

## Contract-derived incorrect implementations

The guide calls this **reverse mutation testing**; the term is not standardized here. Start from the expected contract and create plausible wrong alternatives without mechanically copying the implementation's choices. Execute the same contract tests against each alternative.

For an explicitly specified inclusive 1-5 validator, examples are allowing 0, rejecting 1, rejecting 5, allowing 6, or accepting everything. In Inquisitor, a coverage alternative might wrongly treat a partial day as complete or commit coverage after failed article persistence. Only use examples whose requirements apply to the chosen target.

Confirm the intended implementation passes and each non-equivalent wrong implementation fails for the expected behavioral reason. A variant that cannot be loaded is not evidence that the test suite detects its bug.

## Finish cleanly

Keep production code intact, remove only disposable artifacts created for the experiment, and verify the final relevant suite against the intended implementation. Stop after the bounded campaign and supported corrections; do not chase a perfect score through equivalent mutations. Report assessed variants, kills, survivors, excluded/equivalent cases, invalid runs and remaining blind spots. A high score is evidence of test sensitivity, not proof of correctness.
