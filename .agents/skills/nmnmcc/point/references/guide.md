# Point

Use `$point` for explicit invocation.

## Think from cause to effect

See the task as a small system of cause and effect. First make doubt smaller. Do not make the scope larger. Keep possible reasons apart. Find the smallest part that makes the effect. Get proof that a change to this part gives the wanted result. Set the boundary by cause and proof, not by file count.

Ask: What must change? What part can cause it? What is the simplest check that can show this answer is wrong? What nearby behavior must stay the same?

## Run the loop

1. State the old result, the wanted result, and one local check that can tell if the change works.
2. Work back from the result to the first part that makes it wrong. For a bug, put the possible causes in order. For a feature, find the smallest place to add the new effect and say what it will change.
3. Choose each reading or test by how much it can teach you. Rule out other answers until one cause explains the important behavior and limits. Do not follow a path that cannot change the decision.
4. Make the smallest complete change at the cause. Keep named nearby rules true, including needed failure behavior and compatibility.
5. Run the most direct check and the nearest useful regression check. For a bug, show that the check fails before the change and works after it when this is practical.
6. Report the cause, the changed behavior, the proof, and any important doubt that remains.

## Complete a Point in Cluster

These rules override Point's normal investigation order and direct-check timing only while `$cluster` is active.

Work only inside the module, task card, frozen typed interfaces, allowed public surfaces, and authority given by Line. Infer and implement the module behind those interfaces. Do not inspect a sibling module's internal implementation, coordinate laterally, change a frozen contract, or widen the task. Report a contract problem or wider concern to Line.

During implementation, do not run compilation, type checking, static analysis, linting, formatting checks, or tests. You may name deferred checks, but do not claim proof from checks that were not run. Return the implementation, changed public surface, assumptions, deferred checks, and any contract conflict to Line.

If assigned later as an alignment agent, read and edit only the assigned module plus its frozen interfaces and diagnostics. Do not run checks or change contracts. Return contract changes to Line; the validation coordinator performs the targeted and full checks. Outside `$cluster`, keep Point's normal cause-to-effect loop and direct proof.

## Stop or use another view

- Stop when one cause fits the proof, the result check passes, and you have checked important local alternatives and regressions to a reasonable level.
- Use `line` when the cause is the same broken rule in many parts of one technical domain. Use `plane` when proof must cross a boundary between technical domains.
- Use the skills as views inside one process, not as three full lists. Plane holds the whole and chooses attention. Line keeps shared rules true. Point finds local causes. Explore, make changes, check, and report once. Keep all limits from all active skills. Show any conflict and ask for a decision.
