# DX

## Make the right thing feel natural

Treat every developer who meets the system as a user. Include a new contributor, regular contributor, reviewer, maintainer, operator, and consumer of an API or library when the work reaches them.

Hold one main rule:

> Make meaning easy to see, the intended change easy to make, and the result easy to trust.

Treat correctness as the floor, not the finish. Make code beautiful through honest structure, clear names, useful limits, and calm control flow. Do not confuse beauty with short code, clever code, a favorite style, or perfect visual sameness.

Improve the whole path from first contact to later maintenance. Do not call one fast command or one tidy file excellent DX while setup, navigation, failure, review, or release is still hard.

## Read like a human, from whole to detail

Enter a project through its front door before jumping into an isolated search result. People do not read a repository as one flat set of files or read every line in order. They seek purpose, landmarks, a path, and only then the detail needed for the task.

Read in passes:

1. **Purpose:** Learn why the project exists, who or what uses it, what it promises, and how it is run. Start with the repository name, main instructions, manifests, and visible entry points.
2. **Map:** Learn the top-level parts, their jobs, their owners, and the main dependency direction. Find where input enters, where useful work happens, and where results or effects leave.
3. **Story:** Follow one real action from its entry point to its result. Use this path to turn the static tree into a working system.
4. **Neighborhood:** Enter only the package, module, or feature that owns the task. Read its public surface, close collaborators, rules, and nearest checks before its inner code.
5. **Detail:** Read the relevant type, function, branch, and expression with enough surrounding context to explain its purpose and effect.

At each pass, pause and state the current model in simple words. Predict where the next needed fact should live. Let names and structure guide the next move. If the next fact is somewhere surprising or a local detail does not fit the larger model, move back out and repair the model before changing code.

Use search as navigation, not as understanding. Do not treat the first text match, reference, stack frame, or failing line as the whole cause. Keep the map proportional to the task: do not read the whole repository when one clear path can orient the work.

Keep both directions alive. Move from purpose to system, system to path, path to module, and module to line. Then move back from the changed line to its module promise, full path, and project purpose. Make the macro story and micro behavior agree.

## Imagine and feel the reading journey

Temporarily set aside knowledge that only the author or an agent with full search access has. Imagine arriving as the developer in front of the real repository. Use `I` and ask:

- What do I see first, and what do I think this project does?
- Which names and paths act as landmarks? Which ones send me the wrong way?
- Do I know where I am, why I opened this file, and what I should inspect next?
- What must I keep in my head while moving between files, layers, and tools?
- Where do I hesitate, lose the story, meet a surprise, or have to search by guess?
- Can I predict where a change belongs and what else it may affect?
- After an interruption, can I recover my place without rebuilding the whole model?
- Does reading feel calm and progressive, or scattered and tiring?

Experience the path at human speed. Notice context switches, backtracking, memory load, uncertainty, and the moment the system begins to make sense. Seek the pleasure of growing clarity and control, not novelty or decoration.

Use imagination to find questions and likely friction, not to invent user evidence. Check the imagined path against the actual files, commands, behavior, and history. Use observation from real developers when a claim about their ease, feeling, or habits matters.

## Start from a real developer task

Choose a real task that represents the experience before changing it. Name who does it, what they know at the start, what result they need, and how they can tell it is right.

Run or trace the current path:

1. Enter through the front door and understand the project from whole to detail.
2. Set it up and get the first useful result.
3. Locate the part that owns the change.
4. Edit it without breaking a hidden rule.
5. Get fast and truthful feedback.
6. Understand a failure and return to work.
7. Review, merge, release, observe, and maintain the result as needed.

Inspect the real repository, instructions, manifests, source tree, public interfaces, checks, automation, error output, and change history that matter to this path. Use the installed versions and actual commands. Keep observed facts, developer reports, and your own inferences separate.

Find the step with the most costly doubt, delay, repeated work, surprise, or chance of error. Follow that friction to its cause. A weak name, split source of truth, leaky boundary, slow check, hidden setup rule, or poor error may be the cause; another tool is only one possible answer.

## Write calm and beautiful code

Make the shape of the code match the shape of the problem:

- Make every reading level tell a clear part of one story: repository, package, file, type, function, and expression.
- Use the words of the domain and give one meaning one stable name.
- Put related state and behavior close enough to understand together.
- Keep cause and effect close unless a real boundary must separate them.
- Keep the normal path straight. Make failure, cleanup, and exceptional work visible.
- Give each fact one main source. Derive other forms or check that they agree.
- Use the same shape for the same meaning. Make a real difference easy to notice.
- Order a file so its purpose, public story, and important detail unfold naturally.
- Make comments explain reasons, limits, or surprising facts. Let code state what it does.
- Keep public surfaces small and complete. Hide details only when callers truly need not manage them.
- Remove dead paths and old names after a safe migration makes them unnecessary.

Prefer code that an unfamiliar developer can read without simulating many hidden steps. Avoid clever compression, indirect control flow, needless layers, and abstractions that only move code behind another name.

Follow useful project conventions. Do not reformat, rename, or reorganize unrelated work for personal taste. Repair a convention when direct evidence shows that it causes repeated confusion or error, and change every affected part through a clear rule.

## Give the codebase a clear shape

Give each important idea one obvious home. Let ownership, meaning, trust, or lifetime justify a boundary. Make dependency direction and change impact predictable.

Choose structure from the work rather than from a fixed folder pattern:

- Make entry points and the main path easy to find.
- Give each level enough meaning to choose the right next level without knowing the answer first.
- Keep a change local when its meaning and owner are local.
- Put a shared rule in one place that can keep it true.
- Separate source, generated output, outside code, configuration, and build artifacts clearly.
- Keep names and paths consistent with the concepts developers search for.
- Keep boundaries narrow enough to understand and strong enough to protect their promises.
- Make cross-boundary data, failure, effects, and ownership explicit.
- Remove duplicate adapters, aliases, and compatibility paths when their supported life ends.

Keep the project promise, top-level map, public interfaces, and inner behavior in agreement. Judge the shape by whether a developer can predict where to look, what may change, and which checks matter. Do not make one directory look simple by moving knowledge or repeated work into every caller.

## Design good developer-facing interfaces

Treat an API, CLI, configuration file, error message, log, build task, test helper, and generated file as a product surface.

- Use consistent terms, argument order, defaults, and results.
- Make the common safe action direct. Reveal advanced choices when they become useful.
- Reject bad input at the closest boundary that knows enough to explain it.
- Make errors say what failed, where it failed, why when known, and what the developer can do next.
- Preserve the useful cause and context of a failure without exposing secrets.
- Make help and examples current, runnable, and close to the interface they explain.
- Make machine-facing output stable and human-facing output easy to scan.
- Make configuration sources, defaults, precedence, and overrides discoverable.
- Make escape hatches explicit, narrow, searchable, and harder to use by accident.
- Give changed or removed behavior a clear migration and deprecation path.

Do not use hidden magic to save a small step when it makes behavior hard to predict or debug. A useful default still needs a clear way to inspect and override it.

## Build a fast and truthful feedback loop

Give each common intent one discoverable path: set up, run, check, test, build, release, and repair. Prefer existing project commands when they are clear. Add a script or wrapper only when it removes stable repeated work or keeps a shared rule.

Keep the loop trustworthy:

- Make setup repeatable and state its needed tools, versions, and outside services.
- Detect missing requirements early and explain how to fix them.
- Run the cheapest check that can answer the current question, then widen by changed risk.
- Keep local and CI commands the same where practical; make real environment differences explicit.
- Make tests and builds deterministic. Treat flaky feedback as a defect, not normal noise.
- Use caches only when invalidation is safe and a stale result cannot look correct.
- Show useful progress for long work and keep the final failure easy to find.
- Preserve enough diagnostic data to reproduce or explain a failure.

Never buy speed with false confidence. A quick green result that does not cover the changed promise makes the experience worse.

## Make change and review easy

Keep each change coherent enough to explain and small enough to inspect. Separate a mechanical move from a behavior change when mixing them would hide the meaning. Preserve user work and unrelated changes.

Make the diff tell one clear story:

- Change the cause of friction, not only its nearest symptom.
- State the rule or intent that joins all edited parts.
- Keep behavior changes, compatibility choices, and generated output visible.
- Add documentation where a developer would look for a fact that code or tooling cannot show.
- Add a dependency, tool, framework, or abstraction only when its lasting value exceeds setup, learning, migration, and maintenance cost.
- Avoid a whole-repository rewrite when a smaller complete change can prove the result.

Do not present taste as fact. When several forms are equally clear and safe, prefer the established form and spend change cost on a real developer result.

## Improve the journey at its cause

Use this loop:

1. State the developer, real task, old experience, wanted experience, and one result check.
2. Read from project purpose to the smallest relevant detail and keep a short, correct map of the path.
3. Run or trace the full relevant journey and record the strongest friction with direct evidence.
4. Find the cause and the smallest boundary that can own it.
5. State the clarity, interface, or feedback rule the solution must keep.
6. Make the smallest complete change across every needed code, structure, tool, message, or document.
7. Read the changed detail back outward and make sure it still fits the module, path, and project story.
8. Run the main path and a useful failure-and-recovery path from a realistic starting state.
9. Run correctness, compatibility, and regression checks in proportion to the changed risk.
10. Compare the old and new journey. Remove temporary probes, replaced paths, and repeated facts.

Measure only what can change a decision. Useful signals may include setup success, time to first result, time to useful feedback, failed or flaky runs, recovery time, change spread, and review effort. Numbers do not replace watching a developer perform the task or reading the code with fresh eyes.

## Check the result

Try to show that the improvement is false:

- Can a developer explain the project's purpose and main parts before entering local detail?
- Do names, paths, and public surfaces give enough clues to choose where to read next?
- Can they follow one story from project promise to a line of code and back without losing their place?
- Can a developer find the owning part without knowing its answer in advance?
- Can they explain the code's purpose, main flow, rules, dependencies, and failure path?
- Can they make the representative change without editing unrelated parts or copying a hidden rule?
- Does the closest check fail for a meaningful fault and pass for the right result?
- Does a failure point to its cause and a practical next step?
- Do setup and automation work from the realistic state promised by the project?
- Can a reviewer see the intent and risk without reconstructing them from scattered files?
- Can a developer return after an interruption without rereading unrelated parts?
- Will the next maintainer have fewer facts to hold in mind, not merely different facts?

Check product behavior, safety, and system promises as well as developer ease. Never improve DX by weakening a guarantee, hiding a failure, or moving work to users, operators, reviewers, or future maintainers.

Do not claim that code feels pleasant or easy for all developers from a metric or your own reading alone. Use real developer feedback when the decision needs that evidence. State what was checked and what was not.

## Reject false DX

Do not accept:

- cosmetic cleanup over an unclear model;
- another tool, wrapper, or alias with no removed work;
- a new abstraction used only because a pattern is fashionable;
- visual uniformity that hides real differences;
- automatic discovery or defaults that cannot be inspected;
- documentation that copies a fact and must drift by hand;
- a faster check that is flaky, incomplete, or hard to trust;
- a large refactor mixed into a small product change;
- a friendly success path with no clear failure or recovery path;
- a language, framework, or toolchain change based only on preference.

Count friction moved to another person or later time as friction still present.

## Work with the other skills

Use `study` first to learn the real developer journey and `just-do-it` to turn the next clear improvement into a finished result. Use `ux` when the full human or product experience is also in scope. Use `simplicity`, `typesafe`, `effect`, and `testing` for their engineering rules. Use `point` for one local cause, `line` for one DX rule across a technical domain, and `plane` when the developer result crosses code, tooling, CI, release, or operations.

Use `$cluster` when the developer result divides into at least two independently reviewable workstreams or separate technical-domain owners; keep the journey, integration, and final acceptance in the root `plane` task.

Lead the handoff with the improved developer result. State the task, friction and cause, change, direct proof, effect on correctness, and important cost or doubt left. Finish when the representative task is clear from start to recovery, the codebase tells the truth about itself, feedback is fast enough and trustworthy, and the checks support every claim.
