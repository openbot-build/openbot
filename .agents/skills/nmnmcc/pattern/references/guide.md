# Pattern

## Gate product source code

Before writing or changing product source code, find the Git repository or workspace root that owns it and inspect its `patterns/` directory. Treat a missing directory as no coverage. Do this even when the user does not mention patterns. Treat application and library implementation that ships as product source as gated. Exclude tests, scripts, configuration, migrations, generated code, and documentation examples unless the user explicitly puts them in product source.

Do not edit gated source until coverage passes:

1. Inspect the available pattern children and identify every one whose situation and scope may cover the work.
2. Read each relevant README, manifest, implementation, test, and fixture in full; run its documented checks; and compare its assumptions with the current requirements, versions, settings, code, and behavior.
3. Treat every fitting `candidate` or `established` pattern as active coverage. Follow all of their responses and boundaries. The status records evidence maturity, not permission to ignore a fitting pattern.
4. Treat a `retired` pattern only as history or migration guidance. Follow its active replacement when it has one; otherwise continue as uncovered.
5. When several active patterns apply, satisfy all of them. Stop and ask the user when they conflict.
6. When no active pattern covers the work, qualify, build, and verify a pattern before editing product source. Give it `candidate` status unless it already meets the `established` standard. Then implement the product source by following it.

Do not treat an unreadable pattern or a failed or unverified documented check as passing coverage. Stop and ask the user before repairing that pattern or editing the gated source.

Never lower the qualification standard to clear the gate. When no honest, transferable pattern can be formed, stop before editing product source, explain the missing support, and ask the user how to proceed.

Do not silently override an active pattern. Before changing any existing pattern artifact or making product source deviate from its response or boundary, give the user the pattern path, conflict, evidence, exact proposed change, and consequences, then obtain explicit approval. A user request that explicitly authorizes that exact pattern change or deviation is approval; broad permission to implement a task is not.

## Teach one relation that transfers

Hold one working attitude: TEACH WHAT CAN LIVE BEYOND ONE CASE BY LETTING THE LEARNER RUN IT.

Define a pattern as one teachable relation with five parts:

- **Situation:** the recurring context in which the lesson may apply.
- **Tensions:** the needs, limits, and forces that make a simple answer incomplete.
- **Response:** an adaptable form of action that works with those tensions.
- **Consequences:** what the response enables, costs, risks, or changes.
- **Boundary:** the conditions under which the relation changes or stops applying.

Let code demonstrate the response, tests and experiments reveal its consequences and boundary, and prose help a learner recognize and adapt the relation. When current requirements, supported outside contracts, project settings, or direct evidence disagree with an active pattern, surface the conflict and ask the user instead of silently overriding either one.

## Qualify the lesson

Inspect requirements, code, tests, settings, operating behavior, failures, and decisions before extracting or changing a pattern. Compare real cases, look for different causes behind similar code, and try to refute the proposed relation with a competing explanation or counterexample.

Create a candidate only when:

- all five parts can be stated honestly;
- at least one concrete project case supports them;
- another real case is likely; and
- a runnable example can preserve the important tensions.

Promote a candidate to `established` only when either condition holds:

- an authoritative project rule or explicit user decision defines the whole relation; or
- at least two independent, successful uses support it and their relevant checks pass.

One use is not independent when it was generated, copied, or derived from the other. Polish, isolated tests, silence, and a status label are not evidence of transfer.

Keep a pattern as a `candidate` until a learner can run its documented journey, recognize a new fitting situation, explain why the response fits the tensions, adapt it without copying the implementation, and name a counterexample or boundary. Use `retired` only for a lesson kept to explain old work or guide a move to its replacement.

Repeated code, a rule, recipe, checklist, decision, abstraction, example, failure, one-time choice, or general best practice is not a pattern by itself. Do not create a separate anti-pattern project; show a tempting bad response inside the positive pattern only when the contrast improves the lesson.

## Build one runnable teaching codebase

Find the Git repository or workspace root that owns the source case. Put the pattern in one tracked `patterns/<pattern-name>/` directory there. Use a stable kebab-case name, create `patterns/` only for the first qualified pattern, and do not create a collection unless the user asks for one.

Never initialize `.git` inside a pattern directory or make it a submodule. Never ignore `patterns/` or any owned source, tests, fixtures, manifests, lockfiles, or teaching material. Remove a conflicting ignore rule when the task authorizes pattern work; keep ordinary generated outputs and secrets ignored.

Give each child one pattern and only the files its ecosystem needs:

- a manifest or native project definition and its normal lockfile;
- a small runnable reference implementation;
- automated checks for the main behavior and its most important boundary or consequence;
- owned fixtures, sample configuration, and safe local defaults when needed; and
- a learner-facing `README.md`.

Make `README.md` state the status, five-part relation, source evidence, prerequisites, exact setup/run/check commands, expected observation, guided experiment and its check, cleanup, limits, counterexamples, and transfer questions. Include a tempting alternative only when it teaches something. Prefer stable paths, symbols, commands, tests, and decisions over line numbers, timestamps, commit hashes, raw logs, or copied code.

Keep the first meaningful observation close. Use the project's native toolchain, pin only what repeatability needs, and test observable behavior rather than code shape. Do not require production data, secrets, personal data, or private services. State any unavoidable network, platform, account, or cost dependency before the run command. Use a local substitute only when it preserves the tension being taught. Run the learner commands in the owning repository's CI when CI is available.

## Apply and maintain the lesson

Before applying a pattern, pass the product-source gate. Follow every fitting `candidate` and `established` pattern. Use a `retired` pattern only for understanding or migration.

After the user explicitly approves the exact pattern change, keep code and teaching in agreement:

- narrow the situation or boundary when transfer fails;
- split materially different relations;
- merge duplicate relations into one surviving directory;
- delete a candidate whose support or reusable lesson disappears; and
- retire an established pattern that must no longer guide new work, with its reason and replacement.

Do not force a weak lesson to avoid asking the user. Do not rewrite production code to improve a tutorial. Preserve unrelated user changes. For a read-only task, propose the path, status, journey, and checks without changing files.

## Reproduce the learner journey

From a clean checkout or equivalent clean worktree:

1. install only the documented prerequisites;
2. run the exact setup, reference, and check commands;
3. confirm the documented observation;
4. perform and verify the guided experiment;
5. follow its cleanup instructions; and
6. check for secrets, private dependencies, nested Git metadata, ignored owned files, generated clutter, and undocumented state.

If a clean run is not possible in the current environment, state exactly which step remains unverified and why. Never describe a codebase as runnable based only on reading its code.

Report the coverage decision, every applicable pattern, any user approval, and every created or changed pattern's `patterns/<pattern-name>/` path, status, learner commands, verification results, tracked-file check, and remaining platform or dependency limits. When the task is read-only, do not create or change a codebase; report the proposed child name, status, teaching journey, and required checks instead.

Finish when every product-source change is covered by and follows all active patterns, every approved pattern change is verified, and each created or changed codebase under `patterns/` teaches one qualified relation with code, prose, status, and evidence in agreement.
