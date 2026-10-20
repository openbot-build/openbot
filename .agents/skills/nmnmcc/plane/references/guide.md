# Plane

Use `$plane` for explicit invocation.

## Hold the whole and let Line do the branches

Start with the final state seen by a person or system. Work back through the domains, boundaries, handoffs, and release states that can make that result true or false. `plane` holds the whole shape of a result; it does not demand that every `point` be finished.

Do not expand every domain inside plane. Choose the current cross-boundary question or path, keep the other branches in their proper places, and pass each branch that can be owned and proved inside one technical domain to `line`. Line does the domain work behind that place; plane keeps the relations between Lines and the final result coherent.

A useful Plane can begin as a sketch. At that stage it may contain pseudocode, partial code, placeholders, unresolved names, or syntax that is not yet valid. Its job is to show the shape and relations of the result, not to pretend to be a runnable program.

Ask:

- What must eventually be seen at the end?
- What is the current question: shape, decision, implementation, integration, or release?
- Which relation must Plane resolve, and which domain branches belong to Line?
- Which unknown could change the shape of the whole `plane`, and which conclusions must remain provisional until it is resolved?
- What must be true before a sketch may become an implementation or a release?

## Pass domain work to Line

In plane, `pass` marks a real branch whose details belong to line. It is how a line appears from the plane before its domain result has been integrated:

> This place belongs to the result. Plane preserves its boundary meaning; Line makes the branch work.

Passing keeps the branch visible in the whole while preventing Plane from absorbing domain detail. It is an ownership and attention decision, not laziness, completion, or permission to invent a result. Plane may retain an explicitly unresolved branch when it is outside the current promise, but that is not a completed pass. Once the branch belongs to the promise, passing it means giving it to Line; Line must return a coherent domain result before Plane can call the path complete.

Outside a cluster, this may simply mean continuing the same work through the `line` view. Inside a cluster, it may mean giving the branch to a line agent. The relation between the views stays the same either way.

Pass a branch to line when:

- its outcome has a clear place in the cross-domain result;
- its work and proof can be owned inside one technical domain;
- Plane can state the boundary meaning the branch must preserve; and
- Line can decide its internal rule and local work without redefining the whole result.

Give line only the context that makes the branch meaningful: its place in the result, the boundary expectation, the current stage, and any dependency or acceptance evidence that matters. Use whatever form best fits the work; a rough node, short note, conversation, or direct assignment can be enough. In a sketch, a bare `pass` can mark the place that will become line work. Do not impose a fixed handoff form or turn each marker into a second plane.

If a branch cannot be understood or proved within one domain, it is not line work yet. Keep the cross-domain question in plane, resolve the boundary or split the shape, and only then pass the resulting domain branches to line.

In a clearly marked draft, the literal language construct `pass` or another non-runnable placeholder is acceptable as the location of a line. In source presented as an implementation, use `pass` only when doing nothing is the truthful behavior. Otherwise use the project's honest no-op, disabled, or not-implemented form. Never let a placeholder quietly claim the result that its line has not returned.

Do not treat a passed branch as settled merely because it has been assigned. It remains unfinished when:

- a later statement relies on its answer but is presented as final;
- its line has not returned a coherent domain result and fitting evidence;
- its returned result changes or fails to preserve plane's boundary meaning;
- it protects people, data, money, security, cleanup, or another consequential guarantee that is being promised now; or
- the work has moved to a stage whose artifact is expected to be implemented, integrated, or delivered.

## Let the stage set the standard

Use the same `plane` at different levels of completion. Do not apply delivery checks to a sketch merely because the sketch is written near code.

If a sketch could be mistaken for buildable source, mark its draft state plainly. Do not run syntax, compilation, type, or test checks by habit; use one during sketching only when it can answer the conceptual question currently in doubt.

| Stage       | What the whole view must carry                                                                                                                    | What it does not yet require                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sketch      | Final result, actors, domains, boundaries, current path, line-shaped branches, assumptions, and open decisions                                    | Completed lines, runnable code, valid syntax, compilation, complete types, or full tests |
| Build       | The chosen path's real interfaces, state, effects, failures, and ownership; every required branch has a line owner or an honest unresolved marker | Proof of lines outside the current change                                                |
| Integration | Returned line results preserve meaning across the boundaries the result now crosses; old and new states are understood                            | Exhaustive checks for paths outside the promised integration                             |
| Delivery    | Every promised line is integrated or explicitly refused; required checks and release/recovery evidence match the risk                             | Unrelated checks that cannot change the release decision                                 |

The table is a progression, not a command to advance early. A user asking for a sketch receives a sketch. A user asking for working software does not receive a sketch labeled as done. Move a branch forward when the current stage, user promise, or path makes it relevant.

## Make the full path take shape

1. Name who or what sees the eventual result. State the old result, desired result, and the current stage of the work.
2. Draw the domains and paths for control, data, identity, authority, failure, time, and ownership. Mark the source of truth, trust boundaries, asynchronous work, irreversible actions, and places used to run or observe the system when those relations matter.
3. Choose one cross-boundary path and state why it has the next claim on attention. Keep unrelated paths visible without expanding them.
4. Resolve the unknowns that can change the Plane. For each boundary the current stage reaches, state the meaning, owner, state changes, errors, compatibility, and needed retry or idempotency behavior. In a sketch, these may remain rough or undecided.
5. Pass each one-domain branch on the current path to `line`. Let that line choose its shared rule, cover every affected part, and use `point` for local causes. Keep the cross-domain promise and boundary decisions in plane.
6. Integrate each returned line result into the path. If it exposes a cross-domain question or changes boundary meaning, reshape the plane before asking a line to continue. Replace draft placeholders that would mislead callers.
7. At integration or delivery, check the boundaries that now carry the promise: permissions, failure, concurrent work, recovery, observability, migration, rollout, and rollback in proportion to the result and its risks.
8. Report the visible result, current stage and path, integrated Lines, unfinished or unassigned pass branches, boundary rules, evidence, and remaining gaps.

## Integrate what Line returns

A pass is resolved only when line has made the branch coherent and plane has confirmed that its result preserves the surrounding boundary meaning. Plane owns that integration judgment; Line owns the domain proof.

Ask line to work or revisit a branch when the current path reaches it, a new fact changes it, another line depends on it, or the stage brings it inside the current promise. A permanently empty behavior is a real contract decision in plane, not an unresolved pass.

## Hold a Cluster result

These rules override Plane's normal sequencing and check timing only while `$cluster` is active.

The root remains `plane`; do not add another coordinator layer. Scan every in-scope domain branch, set its Line owner, and define all cross-domain contracts before implementation starts. Freeze those contracts as first-class typed interfaces in each target language or existing framework. Use native dependency injection when the project already has it; otherwise use native typed interfaces. Do not introduce a DI container or shared IDL for Cluster.

After contracts are frozen, dispatch every Line in parallel without dependency analysis or topological ordering. Flatten scheduling only; keep the Plane → Line → Point hierarchy, scope, and ownership. Give each Line only its branch, frozen contracts, allowed public surfaces, authority, and deferred acceptance checks. Lines must not read other Lines' internals.

Wait for every implementation Line to return before any compile, type, static, lint, format, or test check. Then assign one validation coordinator to run project-native checks, group diagnostics by contract and module, and fan out module-local alignment agents in parallel. The coordinator may read contracts, public surfaces, and diagnostics; internal inspection needs Plane authorization. Alignment agents may edit only their module and cannot run checks or change contracts. A required contract change returns to Plane for centralized revision, refreezing, and parallel redispatch of all affected Lines.

The coordinator reruns targeted checks after each alignment round and then full acceptance. Plane integrates the domain results and declares completion only after full acceptance passes. Outside `$cluster`, use Plane's normal staged sequencing and proportionate checks.

## Stop or use another view

- A **sketch** is complete when the whole relationship, current path, important boundaries, line-shaped branches, and decisive unknowns are clear enough to guide the next move. It may not run.
- A **build** is complete when the promised path is implemented to the local standard of its language and project, and remaining gaps are honest.
- An **integration** is complete when the result's meaning and guarantees survive the boundaries it crosses, including relevant old-and-new states.
- A **delivery** is complete when the stated release promise has proportionate evidence, recovery is understood, and no required line remains hidden behind `pass`.

Use `line` for the work behind each one-domain pass. Use `point` inside line for a local question. Use the skills as views inside one process, not as repeated full checklists: plane holds and integrates the cross-domain result, line resolves a domain branch, and point finds a local cause. Show conflicts and ask for a decision when the user must choose the risk, promise, or order.
