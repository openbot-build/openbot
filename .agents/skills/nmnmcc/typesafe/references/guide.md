# TypeSafe

## Build type safety into the code

Use type safety while writing the code. Do not wait for a later review. Do not take "no compiler errors" or "the tests pass" as proof that every type is true.

A **type guarantee** is a fact that code may safely use. Its proof may come from a compiler, a static analyzer, checked code, a runtime contract, a schema, or another trusted check.

> **Keep meaning, runtime value, type or contract, data form, allowed operations, and proof in agreement. Never let code use a stronger guarantee than its proof allows.**

Use this rule at two levels:

- In each place, describe the value honestly and allow only operations that are safe for it.
- Along the full path, keep the guarantee safe from the first source to the final effect.

Use this rule for the full path:

> **End-to-end type safety = correct origin AND complete propagation AND correct consumption.**

Here, **origin** is where the checked path starts, **propagation** is every step in the path, and **consumption** is the final use.

A **boundary** is a point where data moves between code, systems, trust levels, data forms, languages, or versions.

Keep both levels safe. A good local type is not enough if a boundary drops part of its meaning. A full path is not enough if its type or contract is false or too weak to stop a wrong use.

Before writing local code, answer these questions:

- What must the program do?
- Which values and states are possible?
- Which states must not be used?
- Which rules must stay true?
- Which operations and state changes are safe?
- Where do the facts come from, and what proves them?
- Which functions, modules, systems, data forms, and points in time are on the path?
- What facts does the final use need?

Use only as much process as the risk needs, but do not skip a needed fact.

## Learn the checking model in front of you

Find how the project states and checks facts before relying on them. Inspect the language and tool versions, compiler or interpreter settings, static analyzers, runtime validators, schemas, generated bindings, foreign interfaces, and tests that matter to the path.

Learn what each check can and cannot prove:

- A compiler or static analyzer can carry only the facts that its type model, settings, and checked inputs support.
- A gradual or optional checker leaves some values and paths unchecked.
- A runtime contract proves facts only for values that pass through it and only while its conditions still hold.
- A schema proves the data form it checks, not the meaning that the work gives the data.
- A test gives evidence for the runs it observes. It does not prove a rule for every allowed value.
- A comment or documented shape explains intent but is not a check by itself.

Some types exist only before execution. Others are present at runtime. Some languages or tools allow unsafe links even when checks pass. Learn the real model instead of assuming that all type systems give the same proof.

When the project has no static type check, use honest runtime contracts, narrow interfaces, validation, and behavior checks. Do not call a runtime guarantee a compile-time guarantee.

## Keep six parts together

Keep these six parts clear at each important point:

1. **Meaning:** what the value means in the work the program does.
2. **Runtime value:** what is there when the code runs.
3. **Type or contract:** what the language, tool, or checked interface says may be there.
4. **Data form:** the form used in memory, over a link, in storage, or in another version.
5. **Allowed operations:** what code may safely do with the value.
6. **Proof:** the fact, rule, or check that joins the guarantee to the runtime value.

Make all six parts agree. Treat a type or contract as a statement supported by specific checks. Do not treat it as a runtime fact unless the runtime also enforces it.

Keep safety separate from ease and detail:

- Never give a value a guarantee stronger than its proof.
- Keep missing knowledge visible until there is proof.
- Add more detail when later code needs it and proof supports it.
- Do not take the same data shape as proof of the same meaning.
- Do not keep a narrow guarantee after other code, shared state, delayed work, or time may have changed the value.

## Show the full contract

Show every state and rule that can change what the program must do. Do not model only the fields that are easy to describe.

- Include success, no value, failure, and each important state before and after a change.
- Keep two meanings apart when they need different actions, even if their data has the same shape.
- Show needed links between inputs, outputs, object members, and state changes.
- At a boundary you own, stop code from making a bad state or doing a bad operation.
- Show facts that are not yet known instead of hiding them with an easy type or contract.
- Keep one main source for a shared fact. Derive other forms from it, or check that they still agree.

Do not make a type or contract too strong or too wide for its job. A false rule is unsafe. A rule that is too wide may lose a useful fact and let code mix meanings.

An **invariant** is a rule that must stay true. If the available type system cannot show an invariant, keep it true when making or changing the value, or enforce it with a runtime check. State every rule that still has no proof.

Use each function, method, module, protocol, or public operation as a **contract**. A contract says what facts the input must have and what facts the output will have.

- Ask for only the input facts the code needs.
- Promise only the output facts the code makes true.
- Keep important links between input and output.
- Show success, no value, failure, and state change where later code needs to act on them.
- Give code only the power to change data that the operation needs.

Judge a contract by the bad programs it stops, not by how good its names sound.

## Give every stronger guarantee a proof

Make a guarantee stronger only through one of these sources:

- checked code that makes the value;
- a compiler or analyzer that derives it from facts already proved;
- a runtime check or contract;
- another clear and trusted source of truth.

Follow the proof each time the guarantee gets stronger.

- Keep input in the widest honest state while it has no proof.
- Treat unchecked values, unchecked conversions, and ignored check failures as a loss of proof.
- Treat casts, assertions, suppression rules, reflection, foreign calls, caller-chosen types, and hand-written checks as statements that still need evidence.
- Let a runtime check prove only what it checks.
- Let a compiler or analyzer carry known facts. Do not let it seem to create runtime facts.
- Get new proof when the old proof no longer covers the value because code, time, trust, process, or version has changed.

An **escape hatch** is code that goes around the normal checks. When one is needed, keep it at the smallest boundary. Say why it is safe. Return at once to a guarantee that has proof. Do not let an unchecked statement become a hidden rule for the rest of the program.

## Keep every operation safe

Make every creation, branch, call, data change, and state change keep the rule it promises. For each operation, keep these facts clear:

- the guarantee before the operation;
- the action at runtime;
- every state and data form the action can make;
- the guarantee after the operation;
- the proof that joins the before and after states.

The guarantee may change along the way. It may get narrower after a check, wider after a real loss of detail, or different after a real change of form. Do not make the whole path use one type, contract, or data form.

Keep every fact and difference that later code needs. Do not drop meaning without making the loss clear. Do not say a fact is certain without proof.

Make a bad operation impossible to write when the available tools can do so. Otherwise reject it at the first checked interface that knows enough. If an operation can fail, change state, or make a guarantee weaker, make the next code see that result.

## Keep type safety from start to end

Apply the same rules to the full value path.

### Start with a correct origin

At the first checked point, use no stronger guarantee than the way the value was made or the proof supports. Make the source contract include every important value the source can give.

For a value made inside checked code, follow its inputs and the rules used to make it. Start data from users, networks, files, databases, environment settings, foreign code, or other running systems without proof. Give it a stronger guarantee only after a fitting check or another trusted proof.

### Keep complete propagation

At every step, join the input guarantee to the output guarantee. Include function calls, data changes, encoding and decoding, storage, queues, caches, work done later, foreign interfaces, and moves between versions.

Static proof cannot by itself cross a process or trust boundary. Check the data again where needed. Check old stored data and other running versions against the current rule. Carry no value and failure through the path as carefully as success.

Do not let a type that is too wide, a false contract, a wrong binding, or a wrong data form break the chain.

### Use the final value correctly

Write the final code for the guarantee and meaning that arrive, not for a stronger guarantee that would be easier to use.

Handle every state that can arrive. Make a guarantee narrower only with proof. Meet every fact the final operation needs. Keep meanings apart. Do the right action for the value.

If the final operation needs a stronger guarantee, make that guarantee earlier or get new proof at the final point. Do not use an unchecked conversion to rebuild a guarantee that was lost.

Correct use means correct behavior for every value the path may safely give. It does not mean only that an operation happens to work for the common case.

## Work from rule to result

1. State the wanted result, the full set of states, the rules that must stay true, and the ways work can fail.
2. Find the source, proof, trust boundaries, and final use for each value.
3. Choose types, contracts, and interfaces that allow good states and stop bad operations with the tools the project already uses.
4. Write the source and each operation so its runtime result supports its stated guarantee.
5. Keep the guarantee safe through every data form, boundary, and version to final use.
6. After each change, follow the changed guarantee from its first fact to its final effect.
7. Fix a weak or false guarantee at the first point where proof is missing. Do not hide it later with an assertion.

Choose libraries, schemas, generated code, and system design only after you know which rule they must make or keep. Use existing tools when they are enough. Add a new tool only when the need and its lasting value justify the cost.

## Check while writing

Use checks to confirm the safety you built. Do not use them in place of safe design. While writing, ask:

- Can a runtime value have a state that its type or contract says is not possible?
- Can the stated model make a bad state or allow a bad operation?
- Can an operation break a rule but keep the old guarantee?
- Can a step lose a needed fact or add a fact with no proof?
- Can all available checks pass while the final code still does the wrong action?

Match each check to the fact it must prove:

- Use the compiler, type checker, or static analyzer for the links it can prove.
- Use runtime contracts and schemas for facts that exist only when the code runs.
- Use behavior tests for operations and rules left outside those proofs.
- Use data-form, foreign-interface, and version tests for boundaries.
- Check the final result for correct use.

Finish only when every stated guarantee has matching proof, every allowed operation keeps its contract, and one safe chain runs from each source through every step to the right final use. State every rule that still has no proof, and make the safety claim no stronger than the available checks allow.
