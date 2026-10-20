# Testing

## Seek information, not green

A test is an experiment that distinguishes required behavior from a credible wrong behavior. Its value is the important error it can expose, not the fact that it passes. A green check that was certain from its construction adds no trust.

Do not assume that every code change needs a new test. First find the uncertainty that matters. Use the most direct sound way to reduce it: an existing test, a compiler or type check, a schema or data rule, inspection, a reproduction, a runtime test, a measurement, or an exploratory check. Sometimes the right result is no new test. A non-test check counts only for the exact wrong state it excludes at the relevant boundary; do not replace testing theater with proof theater. Inspection can establish the present source shape, but not by itself how a framework interprets it, what a query returns, what is deployed, how concurrent work is ordered, or which outside effect occurs.

Test behavior the project owns and a real caller can observe. A passing test gives evidence only for the case, boundary, environment, and fault-detection power it actually exercised. It is not a proof that the software is correct.

## Require a real question before any new experiment

Before creating or running a new test, script, manual check, or temporary probe, identify:

- A concrete unknown that the current code output does not answer by itself
- At least two observations still possible under the available evidence
- Which belief, implementation, investigation, or release decision each observation could change
- Why this is the most direct proportionate way to learn that information

State those alternatives before the first run. If the expected output was merely copied from the implementation, there is no independent question. If every outcome leads to the same next move, do not run the experiment. “Confirm behavior” and “gain confidence” are not findings unless they name a credible wrong world that remains possible and a decision its exclusion would change.

An exploratory probe may start without knowing which observation is correct. It still needs a real unknown and outcomes that would change the investigation. Do not use a disposable probe as an escape from these rules or report its green output as progress by itself.

## Make a lasting test earn its place

A test that will stay in the project needs separate support for each of these:

- **Requirement:** An acceptance rule, product or system contract, supported prior behavior, or other source says which behavior matters.
- **Fault credibility:** Evidence apart from the requirement shows why a neighboring wrong behavior remains plausible. This may be an observed bug, a mechanism in the actual change, a fragile boundary, a prior failure pattern, interacting state or order, time or concurrency, outside variation, or high-consequence exposure.
- **Oracle:** A source independent of the implementation can determine the wanted result.
- **Sensitivity:** The test has been shown able to distinguish that particular wrong behavior from the required one.
- **Incremental information:** Existing tests, types, schemas, constraints, inspection, and other checks do not already exclude the same fault.
- **Lasting value:** The fault can recur, a future failure would guide action, and the signal is worth its maintenance cost.

Do not let one fact stand in for all six. A requirement explains what is wanted; by itself it does not make an implementation fault plausible. An oracle supplies the expected result; by itself it does not show that the test can detect the suspected fault. A changed line, missing coverage, ordinary typo, hypothetical future edit, or the bare claim that anything could fail is not fault evidence. High consequence can justify guarding a simple rule when a real exposure or failure mechanism also exists.

Establish sensitivity in a way tied to the named fault:

- For an observed bug, reproduce the bad example and see the test fail for the product reason on the pre-fix behavior. If that version can be run safely without disturbing user work, this is required; if it cannot, state why and do not substitute an unrelated mutation.
- For an intentional behavior change, see the test reject the old behavior only when return to that behavior is the credible regression being guarded.
- Safely introduce a small fault derived from the suspected mechanism and confirm that the test catches it.

A syntax error, broken fixture, missing import, arbitrary deleted return, absurd constant, or impossible toy mutation does not establish sensitivity. Do not invent a foolish implementation merely to perform a red-green ritual. When feasible, check that the test also accepts a different implementation that meets the same contract; otherwise it may guard the current shape rather than the behavior.

If any needed support is absent, do not turn a guess into a lasting test. Resolve the requirement, use a more fitting existing check, run a justified exploratory probe, or report the remaining uncertainty.

## Reject circular checks

Do not add a test that:

- Restates literals, branches, private helpers, or calculations from the implementation
- Computes the wanted result with the same algorithm or helper as the code under test
- Makes a stub return a value and then only checks that the same value came back
- Verifies mock calls that are not themselves a product or system contract
- Retests a guarantee supplied by the language, framework, vendor, type system, or schema without exercising the project's choice, configuration, wiring, version, migration, or deployment of it
- Checks a getter, constructor field, constant, or default with no credible way for the project to get it wrong
- Adds a snapshot when the exact complete output is not the promise
- Adds examples only to increase case count or code coverage

Such checks may be green while saying almost nothing. Delete them or replace them with a check that can disagree with the implementation for a meaningful reason.

## Study the real system first

Before deciding what to test:

- Read the requested behavior, acceptance rules, real callers, current code, changed code, and nearest tests.
- Find the normal commands, settings, fixtures, helpers, test data, and shared `CI` checks.
- Inspect relevant issue examples, failures, contracts, and history when they exist.
- Find what existing tests and non-test checks already establish.
- Run a nearby existing check when it gives a useful baseline or can reveal a regression.

Judge a test by what it actually runs and observes, not by a folder or a label such as `unit`, `integration`, or `end-to-end`.

For a review or diagnosis, inspect and report. Change product code or tests only when the requested work includes that change.

## Put the boundary around the uncertainty

Choose the narrowest runtime boundary that contains both the suspected failure mechanism and an independent observation of its consequence. Do not shrink the test past the thing in doubt.

- Use a unit boundary for a local rule when the likely fault and its result are both local.
- Use a real component or integration boundary for framework behavior, queries, storage, files, serialization, processes, or work between parts.
- Use a contract boundary where independently changing parts must agree on data, errors, order, or supported versions.
- Use an end-to-end boundary when only deployed links or a complete important journey can show the risk.
- Use a benchmark, load check, fault injection, or guided exploration when the question concerns capacity, failure, recovery, or behavior that examples cannot settle.

Use more than one level only when each one can expose a different credible fault. A unit test with a mock cannot establish that a real query, conversion, deployment, or outside contract works. The smaller test wins only when it gives equally relevant evidence and better fault location.

## Choose cases that may reveal something

Choose cases from the promise and credible ways it could fail, not from branches in the code.

- Preserve a real failure as a named case when the underlying risk remains.
- Split inputs or states into groups only when a likely fault could treat the groups differently.
- Check just below, at, and just above a boundary when the rule changes there.
- Check allowed and forbidden state moves, or important event orders, when history changes the result.
- Check refusal, failure, recovery, or absence of an effect when each guards a distinct harmful outcome.
- Use a decision table when interacting conditions create meaningfully different results.

One strong counterexample is better than several unsurprising happy-path examples. A happy path is worth keeping when it is an important acceptance path or a credible regression could break it.

An assertion being simple or its expected result being obvious neither earns nor disqualifies a test. Keep it when the rule is consequential and a credible regression can violate it; reject it when the check cannot add information.

Use a property or fuzz test when one independent rule covers a large input space and generated cases could find surprises. Supply a separate oracle or invariant, keep useful edge inputs, save the failing seed, and reduce failures to clear examples. These searches find counterexamples; they do not prove correctness.

Do not test every combination without a reason that connects it to a fault and consequence.

## Keep the observation independent and clear

Take wanted results from an acceptance rule, external contract, prior released behavior that must be preserved, trusted reference, invariant, or another source independent of the implementation. Current behavior is evidence, not a requirement by itself. If the rule is ambiguous, do not freeze an implementation choice in a characterization test; resolve or report the ambiguity.

Use the public interface or the same path as a real caller when possible. Check exact results, saved state, lasting effects, meaningful errors, and important effects that must not happen. Check internal calls only when the call, count, order, notice, or forbidden write is itself the promise.

Name the condition, action, and wanted result. Keep setup small but show every fact needed to understand the case. Perform one main action. Keep together all checks that describe one observable result. Prefer plain test code over clever helpers that hide why the case matters.

Use real parts when they are fast, safe, repeatable, and contain the behavior in doubt. Use a fake for a simpler working part you own, a stub for one fixed answer, and a mock only when contact itself is the observable contract or no result or state can be observed. Put doubles at stable owned boundaries and keep a real contract check where doubles may drift.

## Keep the signal trustworthy

Control clocks, random sources, work order, names, ports, external answers, and failure points that can change the result. Give tests isolated short-lived state and clean up what they create. Wait for an observable event with a limit; do not sleep for a guessed time.

A flaky test is faulty evidence. Rerun it to investigate, not to turn red into green. Find the hidden input or race. Quarantine it only as a short, owned repair step when it harms the main signal.

Read each new or changed test as carefully as product code. Confirm its sensitivity with the bad example or a safe mutation derived from the named fault mechanism.

Never weaken an assertion, replace real behavior with a mock, add retries, update a snapshot, or remove a test merely to obtain green. First determine whether the promise, implementation, test, data, or environment is wrong.

## Run checks to learn and guard

Run the narrowest relevant check while learning. After the behavior works, run nearby checks for local regressions, then wider checks only across contracts, settings, deployed links, and journeys touched by the change. Run the project's normal `CI` command before completion when its cost is proportionate and the environment permits it.

An existing suite that remains green can show that it found no covered regression. It does not validate new behavior unless its checks could distinguish that behavior from a credible wrong one. Do not run unrelated commands merely to report activity.

Read every failure. Distinguish a product fault, test fault, setup fault, flaky signal, and unrelated existing failure. Fix only what the work owns, but report every fact that limits trust.

## Report evidence without rewarding activity

Report:

- The behavior and credible risks examined
- Which existing evidence was enough and why any new test was needed
- Which credible wrong behavior each new test distinguishes, the separate sources for its requirement and fault credibility, and how its sensitivity was checked
- The exact checks run and their observed results
- Important boundaries, environments, and risks that remain untested

If no new test would add information, say so plainly. That is a sound testing result, not missing work.

Do not present test count, coverage growth, snapshots written, or a green command as an achievement by itself. State what was learned or guarded. Never say a check ran when it did not, and never turn a passing sample into a general guarantee.

Stop when the next check cannot exclude a credible wrong behavior that existing evidence still leaves open and whose exclusion would change the current decision. The requested software behavior and proportionate evidence define done; green tests do not.
