# Docs

## Help a real reader act on the truth

Treat documentation as part of the software. Make it agree with the system, help a named reader do real work, and keep it easy to check and change.

Hold one main rule:

> Keep code and its needed explanation together: give the right reader the smallest true explanation, in a place whose owner and reader path can keep it true, in the same verified change.

Do not write prose only because a file, function, or change exists. Write when a reader needs meaning that the code, interface, or tool cannot show well enough by itself.

## Start with the reader, task, and system

Before writing, state:

- Who will read this and what they already know
- What they need to understand, decide, or do
- Where they start and what result they need
- How they can tell that the result is right
- What may go wrong if the explanation is missing or false

Then inspect the real system. Read the project front door, nearby source, public interfaces, types, settings, tests, commands, running behavior, and change history that can support or refute the explanation. Read existing documentation to learn its terms, structure, and useful conventions.

Follow one real path from purpose to result. Keep checked facts, supported inferences, plans, and unknowns separate. Never turn a planned state into present fact.

Find the main source for every important claim. If no source can keep a claim true, narrow the claim, create a fitting check when the project owns one, or state the limit.

## Keep documentation with the code

Treat "together" as shared ownership and lifecycle, not a rule that every explanation must be in the same file.

When the user asks to implement software, make the working behavior the primary result. Change the owning code and its checks. Add or update only the documentation needed to understand, use, change, or operate that behavior. Never deliver prose in place of the requested implementation.

Inspect the existing project structure before creating a path. Move outward from the code only as far as the reader need requires:

1. Make code, names, types, and tests carry facts they can state and check.
2. Put a public contract in the owning interface or docstring.
3. Put a local reason or invariant beside the code it controls.
4. Update the nearest existing README or reference that guides readers to the changed part.
5. Update the root README for project-wide purpose, entry, setup, or navigation.
6. Use an existing documentation tree for material that truly crosses local owners.

Choose the location from the relations in the real system:

- **Meaning:** Keep a fact near the code or interface that gives it meaning. Move it outward when it explains a relation across several parts.
- **Ownership:** Put the explanation where the person or part responsible for its truth can find and maintain it.
- **Change:** Prefer a location that a maintainer will meet when changing the behavior that can make the explanation false.
- **Reader path:** Put navigation where the reader starts and detail where the reader needs it. Link the two instead of copying facts.
- **Lifetime:** Keep material with the code when they change and retire together. Give it a separate home when it has a real shared owner, version, release, or operating life.

A documentation tree fits when several durable documents share a reader path, navigation, owner, and lifetime across code areas. A local README, docstring, or comment fits when one code owner carries the meaning. No directory is right by itself; let these relations and the project's established shape decide.

For a documentation-only request, do not invent product behavior or unrelated code changes. Still find the code, interface, setting, or operating path that owns each fact and keep the documentation connected to it.

## Choose the right carrier

First ask whether prose is the best carrier for the meaning:

- Use clear code, names, types, and structure for behavior they can state directly.
- Use a docstring, which is documentation attached to code, for a public contract that callers need.
- Use an inline comment for a reason, limit, invariant, or surprising fact near the code it controls.
- Use a top-level README for project purpose, the first useful path, and a map to deeper material.
- Use a local README for the purpose, boundary, and entry points of one owned part.
- Use a tutorial to teach through a guided learning path.
- Use a how-to guide to help a prepared reader reach one practical result.
- Use reference material for exact facts that a reader looks up.
- Use concept or architecture documentation for a model, relation, boundary, or important reason.
- Use a runbook, which is an operating and recovery guide, for a live action with checks, stop conditions, and a way back.
- Use migration documentation for the path from an old supported state to a new one.

Keep these purposes clear even when a small document combines them. Do not make a reader search a long story for one exact fact or mistake a copyable example for the full rule.

## Give each fact one clear home

Put a durable fact with the part, interface, rule, or owner that can keep it true. Link to that source from other reading paths instead of copying it.

- Derive repeated mechanical reference from code, schemas, settings, or another checked source when practical.
- Keep navigation close to the reader and detailed truth close to its owner.
- Use one stable term for one meaning across code, interfaces, and prose.
- Prefer stable paths, symbols, commands, and names over line numbers, raw logs, dates, or screenshots.
- State the version, platform, environment, or support window when a fact does not hold everywhere.
- Keep private data, secrets, and unsafe values out of documentation and examples.

Do not make one document look complete by repeating facts that must be maintained elsewhere. Count knowledge moved to another file or future maintainer as knowledge still in the system.

## Write from purpose to proof

Order information so the reader can move from the whole to the needed detail without losing the story.

- Start with purpose, audience, assumptions, and the result before inner detail.
- Use headings that name reader questions or tasks.
- Put prerequisites before the action that needs them.
- Put a check after an important step so the reader can detect a wrong state early.
- For an action, state the normal path, expected result, useful failure, recovery, and cleanup when they matter.
- For an explanation, state the main idea, its parts and relations, its boundary, and its consequences.
- For reference, use a stable shape and exact terms. Keep story and opinion out of facts that must be scanned.
- Mark requirements, defaults, choices, examples, and advice so the reader can tell them apart.
- Use short, direct sentences and common words. Keep needed technical terms and explain them simply.
- Use descriptive links and give diagrams or images text that carries the same needed meaning.

Make every claim no wider or stronger than its evidence. Say what was checked, in which state, and what remains unverified when that difference matters.

## Document contracts, not visible syntax

Describe a public API, command, setting, file form, or protocol in terms of what its user may rely on. Include only the parts that change correct use:

- Meaning, required input, and the relation between input and result
- Success, no value, refusal, and failure when callers must act differently
- State changes, outside effects, permissions, cost, and cleanup
- Ownership, mutation, lifetime, order, work done at the same time, and cancellation
- Units, ranges, defaults, compatibility, security, and performance limits

Include a part only when it is real and useful for that contract. Do not repeat a signature, type, field name, or default that the interface already states clearly and keeps true.

Show the difference between a guarantee and a common example. If the contract crosses a process, trust, data, or version boundary, document the form and meaning that both sides must keep.

## Write comments for meaning the code cannot carry

Improve the code before adding a comment. Use a clearer name, type, function, boundary, or control flow when it can make the same truth direct and checked.

Keep an inline comment when it preserves needed meaning such as:

- Why this approach exists and which tempting change would break the result
- An invariant or order that several lines must keep
- A safety, security, compatibility, performance, or resource limit
- A rule from an outside system that the local code cannot express
- A surprising mathematical, protocol, timing, or concurrency fact
- The reason for a narrow escape hatch and the proof that makes it safe

Place the comment before the smallest part whose change could make it false. State the current reason and constraint, not the author's history. When an outside source matters, link to a stable source and state the conclusion the code depends on.

Use a docstring for a public contract, not for a private implementation that clear code already explains. Do not add a docstring only because a name is public. Add one only when it carries a contract or meaning that the name, type, and signature cannot state; give a caller enough information to use that contract correctly.

Do not:

- Narrate each line or restate a name, type, branch, or loop
- Keep commented-out code or a change log inside current code
- Use a section banner instead of giving the code a clear shape
- Add a TODO without a specific missing result and enough context to act on it
- Leave a warning after the danger or constraint no longer exists

Delete or update a comment in the same change that changes the truth it carries.

## Make examples safe and runnable

Treat an example as an executable claim when the system can run it.

- State required tools, versions, accounts, data, and starting state.
- Keep the first meaningful result close and the example no larger than its lesson.
- Use safe local values. Mark placeholders clearly and never invite a reader to paste a secret.
- Show enough expected output or state for the reader to know that the command worked.
- Include an important failure or correction when the normal path alone could mislead.
- Test copied code through the public interface and exact commands the document gives.

Run the documented journey from a clean or realistic state when practical. If a command, link, example, platform, or outside service was not checked, say so exactly. Do not turn reading the text into a claim that the journey works.

## Keep documentation alive

Change documentation with the behavior and contract it describes, in the same implementation change when practical. Search outward from a changed source to every reader path that may now be false. Do not call an implementation task complete when only its documentation exists.

- Update or remove old names, commands, defaults, diagrams, examples, and migration paths.
- Keep old-version material only while it serves a supported reader, and label its state.
- Preserve the reason for a durable decision, not the full discussion that led to it.
- Promote lasting facts from issues, pull requests, and chat into their owned document; do not copy the whole conversation.
- Use generation, link checks, documentation builds, or runnable examples when they keep an important repeated rule at fair cost.
- Do not add a new documentation tool when an existing project check or one direct run gives enough trust.

Delete a document when its reader need is gone or a stronger source now serves it. Before deleting it, make sure no needed meaning disappears with it.

## Work from need to proof

1. State the requested software result, reader, task, starting state, and closest source of truth.
2. Read the owning code and the existing documentation structure. Map documents and comments that already serve or conflict with the need.
3. For implementation work, make the behavior and its code-level checks work. Do not use documentation as its substitute.
4. Choose the carrier and location from meaning, ownership, change, reader path, and lifetime. Keep navigation and detailed truth connected without copying facts.
5. Write the normal reading or action path from purpose to result. Add only needed contract, failure, recovery, and boundary detail.
6. Trace every important claim back to code, settings, tests, behavior, or an authoritative outside source.
7. Run the closest useful software checks, commands, examples, links, and documentation checks. Exercise a meaningful failure and recovery path when the document promises one.
8. Read again as the target reader. Remove repeated, obvious, stale, or unsupported text.
9. Report the implemented result, changed code and documentation, checks run, and every important limit that remains.

## Check the result

Try to show that the documentation is wrong or unnecessary:

- Can the intended reader find it without already knowing the answer?
- Can they reach and check the result from the stated starting state?
- Did an implementation request produce working code and behavior, not only prose?
- Do the code, interface, behavior, and prose tell one story from whole to detail?
- Does every important claim have a source that can keep it true?
- Are commands and examples safe, current, and runnable as written?
- Does a useful failure lead to a clear cause, next step, or way back?
- Do comments preserve non-obvious meaning instead of narrating code?
- Can a change to the owning rule reveal which documentation must change?
- Has repeated or old truth been removed?
- Does each location make ownership, change impact, reader path, and lifetime clear?
- Is every unverified boundary stated without hiding it?

Do not call documentation complete because it is long, polished, or passes a style check. Finish when the right reader can use the real system, the system and prose agree, and the checks support the claims.

## Reject false documentation

Do not accept:

- prose used to excuse unclear code or a broken interface;
- documentation delivered instead of requested working software;
- a location chosen by habit rather than meaning, ownership, change, reader path, and lifetime;
- a broad overview with no real reader or task;
- comment or docstring coverage as a goal;
- copied facts that must drift by hand;
- examples that were never run but are presented as working;
- a friendly success path with no needed failure or recovery path;
- screenshots used as the only source for exact or changing facts;
- old implementation history stated as a present reason;
- visual sameness that hides real differences; or
- a large document that leaves the reader to find the small truth alone.

## Work with the other skills

Use `study` first to learn the real reader, system, and evidence. Use `just-do-it` to turn the next clear documentation need into a finished result. Use `dx` for the full developer journey and `ux` when end-user experience is also in scope. Use `simplicity` to keep one source for each fact, `typesafe` and `effect` to state honest contracts, and `testing` to check runnable claims.

Use `point` for one local comment or document, `line` when one documentation rule must hold across a technical domain, and `plane` when the reader result crosses code, API, operations, release, or support.

Use `$cluster` when the documentation result has independent readers, sources, or delivery paths that need coordinated agents; keep the reader-facing result under the root `plane`, with domain work in `line` and local evidence in `point`.

Lead the handoff with the reader result. State the changed documents or comments, the source that supports them, the checks run, and any important claim left unverified.
