# Line

Use `$line` for explicit invocation.

## Take the branch behind Plane's pass

Line is the expanded view of the domain work represented by a `pass` in Plane. Plane keeps the branch's place and boundary meaning; Line makes that branch coherent and returns a result that Plane can integrate. Assignment is not completion: the pass remains unresolved until Line has covered the domain and Plane has accepted the returned result at its boundary. This relation does not require another agent unless `$cluster` is active.

Start with one statement that must be true in every needed place for the branch to work. The technical domain is every part that can keep or break this rule, not only one folder. Put the rule in one clear place. Make every necessary difference clear. Do not make the same decision again in every part.

When Plane supplies a branch, preserve its surrounding result, boundary expectations, and current stage without taking ownership of the whole Plane. When Line is used independently, derive the domain result and rule directly from the user's request.

Ask: What result must this branch return to Plane? What must be true everywhere in this domain? Who owns this rule? Where can parts move away from it? Which differences are needed, and which happened by mistake?

## Make the domain follow the rule

1. State the branch result and write its domain rule so a useful check can distinguish it from a broken result. Preserve the boundary meaning received from Plane. Set the domain boundary and owner, and list every allowed exception with its reason.
2. Make a full map of parts that make, use, apply, or check the rule. Add all compatibility needs. Mark each part as following the rule, different from it, an allowed exception, or not yet known.
3. Compare the different forms and find what each difference means. Choose one standard way to state and apply the rule. Make it hard for parts to move away from this way later.
4. Put the work in a safe order: add the new way, move each part to it, make the rule active, and remove the old way. Keep every middle state safe and consistent. Use `point` to find and fix the cause in each small move. Do not open the main rule for decision again.
5. Make interfaces, state, errors, names, observability (logs, measures, and traces), and tests follow the rule. Keep a needed exception at the smallest boundary that can hold it.
6. Prove behavior and full coverage as two separate things. Test the standard rule and some parts that use it. Then use the map, search, or static checks to show that no unknown or old form remains.
7. Return one coherent branch result: the rule and its main source, the state of every affected part, behavior and coverage evidence, wanted exceptions, and any concern Plane must resolve. Use the form that best lets Plane integrate it; no fixed handoff shape is required.

## Keep the work in its fitting view

Use `point` for a local cause, change, or direct check inside the branch. Give Point the domain rule and only the surrounding context it needs. Line remains responsible for joining Point results, proving domain coverage, and returning the completed branch; a Point result does not resolve Plane's pass by itself.

If the work no longer fits one technical domain, the boundary expectation is insufficient, or the result would change another Line, return that concern to Plane. Do not quietly widen Line into another Plane or make a cross-domain decision with only a domain view.

## Keep a rule in Cluster

These rules override Line's normal safe ordering and check timing only while `$cluster` is active.

Take the branch and frozen cross-domain contracts from Plane. Scan every in-scope module in the domain, set Point ownership, and define all shared domain contracts before any Point implements. Freeze them as first-class typed interfaces in the target language or existing framework. Use an existing native dependency-injection form when available; otherwise declare native typed interfaces and let Points infer their implementations. Do not add a DI container or shared IDL.

After contracts are frozen, dispatch every Point in parallel without dependency analysis, independence proof, or topological ordering. Flatten scheduling only; keep the Plane → Line → Point hierarchy and module boundaries. Each Point gets its module, task card, frozen interfaces, allowed public surfaces, edit boundary, and deferred checks. It must not read sibling internals.

Do not let implementation Points run compile, type, static, lint, format, or test checks. Accept their returned changes, assumptions, and contract conflicts without treating them as proof. Join them into one domain result for Plane. A contract conflict returns to its owning parent; it is not settled laterally.

After all Cluster implementation is complete, cooperate with Plane's validation coordinator. Alignment work stays module-local and parallel. An alignment agent may not change a contract or run checks. Contract changes return to Line or Plane for centralized revision, refreezing, and parallel redispatch. Outside `$cluster`, keep Line's normal ordered migration and direct coverage proof.

## Stop or use another view

- Stop when the rule has one clear form, every affected part has a known state, no part differs by mistake, and every exception is wanted and visible.
- Use `point` when several files are still one small system of cause and effect. Return to `plane` when the result cannot be proved inside one technical domain.
- Use the skills as views inside one process, not as three full lists. Plane holds the whole and passes domain branches, Line resolves each branch, and Point finds local causes inside it. Explore, make changes, check, and report once. Keep all limits from all active skills. Show any conflict and ask for a decision.
