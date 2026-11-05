# Read the source

Skills, blog posts and model memory are second-hand and go stale (Effect v3 →
v4 renamed a large part of the API). The installed package is first-hand: it
ships its own TypeScript source, API documentation as JSDoc, maintained
examples, and its own style guide. Make reading it a reflex, not a last resort.

**Rule:** if you are about to use an API you have not seen *in this project's
installed `effect`*, find it in `node_modules/effect` first. If this skill and
the source disagree, the source wins — and the skill needs fixing.

## What ships in `node_modules/effect`

| Path | What it is | Use it for |
| --- | --- | --- |
| `CLAUDE.md` / `AGENTS.md` | the library authors' own style rules for writing Effect | idioms (`Effect.fn`, `Schema.TaggedError`, services) |
| `ai-docs/src/**` | maintained, typechecked examples by topic, with `index.md` per section | the first stop for "how do I do X" |
| `src/<Module>.ts` | the **public API**, with full JSDoc per export | signatures, behaviour, gotchas, examples |
| `src/<area>/*.ts` (`http`, `sql`, `ai`, `cli`, `cluster`, `rpc`, `workflow`, `crypto`…) | the former separate packages | those modules |
| `src/internal/*.ts` | the **implementation** (not public API) | answering "what does it actually do?" |
| `dist/*.d.ts` | what TypeScript resolves your imports against | the exact types you are compiling with |
| `package.json` `exports` | every importable subpath | the only valid import paths |
| `node_modules/@effect/<pkg>/src` | platform adapters, SQL drivers, AI providers, vitest | integration code |

Do not read `dist/*.js` (compiled output). Do not import from `internal/`; it is
free to change in any release.

## Anatomy of an API entry

Every export in `src/<Module>.ts` follows a documentation convention. Read all
of it — the useful parts are rarely the first line.

- **Summary line** — what it returns.
- **When to use** — the intended situation (often says which neighbour to use instead).
- **Details** — evaluation order, what is interrupted, what is retained.
- **Gotchas** — behaviours that surprise people. Read these before using the function.
- **Example** — real code. In the Effect repository these are executed as tests
  (`ts import.meta.vitest` fences), so they are known to run.
- **`@see`** — the related functions. Follow them; the right function is often one link away.
- **`@category`, `@since`, `@stability`** — where it sits in the module, when it
  appeared, and whether it is `stable` or `unstable` (unstable APIs may change in a minor release — pin exact versions).

Example of what a gotcha buys you: the JSDoc on `Effect.retry` states that the
source effect runs once before any retry policy applies, so `Schedule.recurs(3)`
means *three retries after the first attempt*, and that defects and
interruptions are never retried. Without reading it, "retry 3 times" is
ambiguous and "retry everything" is a guess.

## Recipes (copy these commands)

```bash
# Where is it exported? (a name can exist in several modules)
grep -rn "export const catchTag\b" node_modules/effect/src --include=*.ts | grep -v internal

# Read an export's docs and signature (adjust -A to taste)
grep -n "export const retry\b" -B 60 node_modules/effect/src/Effect.ts | less

# What does the compiler see? The declaration, with inferred overloads
grep -n "retry" node_modules/effect/dist/Effect.d.ts | head

# How is it implemented? Public modules delegate to internal/
grep -rn "export const retry\b" node_modules/effect/src/internal

# Every public function whose docs mention a topic
grep -rln "Gotchas" node_modules/effect/src | head
grep -rn "interrupt" node_modules/effect/src/Effect.ts | grep "^\S*: \* " | head

# How do the maintainers use it?
grep -rn "Layer.provideMerge" node_modules/effect/ai-docs/src | head

# Is it stable? Since when?
grep -n "export const makeUnsafe" -B 30 node_modules/effect/src/Context.ts | grep -E "@stability|@since"

# Valid import paths
node -e 'console.log(Object.keys(require("./node_modules/effect/package.json").exports))'

# What changed between two versions? Keep a copy of the old install and diff
diff -ru old/node_modules/effect/src/Schema.ts node_modules/effect/src/Schema.ts | less
```

## Reading order for a newcomer

1. `CLAUDE.md`, then `ai-docs/src/index.md` and the examples under `01_effect/` (services, errors, resources, running).
2. The header comment of `src/Effect.ts`, then `Cause.ts` and `Exit.ts` (how failure is modelled).
3. `Context.ts` and `Layer.ts`: the dependency system you will use every day.
4. `Scope.ts` and `Effect.acquireRelease`: how lifetimes work.
5. Once: in `src/internal/effect.ts`, find `class FiberImpl` and its `runLoop` — a
   short read that demystifies "what happens when an Effect runs" (the effect is
   a tree of instructions; the loop interprets them, checking for interruption).
6. The module you are about to use: its header, the functions you call, their `@see`s.

## How to read an implementation

- The public file usually only re-exports the internal one with a precise type:
  `export const retry: { ... } = internal.retry`. The documentation lives in
  the public file, the behaviour in `internal/`.
- Most data-last/data-first APIs are built with `dual(arity, impl)`, which is why
  `Effect.map(self, f)` and `self.pipe(Effect.map(f))` both work.
- Combinators are small compositions of primitives. If `internal/effect.ts` says
  `gen` or `retry` is a dozen lines of `flatMap`, that is the whole semantics.
- To understand a *type* (what `E`, `R` result from a call), read the overloads in
  `dist/*.d.ts` or hover in the editor; the types are the contract.

## Turn what you read into an experiment

Reading tells you what the authors *claim*. Encode the claim as a runnable
check so you know it holds for the version you pinned, and so it fails loudly
when an upgrade changes it. The experiment below verifies the two `retry`
claims quoted above; it runs as a doctest in this repository.

```ts import.meta.vitest name="reading-the-source.md#retry-experiment"
import { Effect, Exit, Schedule } from "effect"

// Claim 1: the first attempt is free; recurs(3) allows three *retries*.
let calls = 0
const alwaysFails = Effect.suspend(() => {
  calls++
  return Effect.fail("nope")
})
await Effect.runPromiseExit(alwaysFails.pipe(Effect.retry(Schedule.recurs(3))))
calls // => 4

// Claim 2: defects are never retried.
let defectCalls = 0
const defect = Effect.suspend(() => {
  defectCalls++
  return Effect.die("bug")
})
const exit = await Effect.runPromiseExit(defect.pipe(Effect.retry(Schedule.recurs(3))))
defectCalls // => 1
Exit.isFailure(exit) // => true
```

Keep experiments like this next to the decision they justify (a test, or a `ts
import.meta.vitest` fence in your own docs).

## Rules for agents

1. Unfamiliar API ⇒ grep and read its JSDoc **before** writing code that uses it.
2. Quote the file you relied on when you explain a non-obvious choice
   (`src/Effect.ts`, the `retry` gotchas).
3. Prefer `ai-docs` and the entry's own examples over invented patterns.
4. If the source contradicts a guide, trust the source, tell the user, and fix the guide.
5. When behaviour is still unclear after reading the public file, read `internal/`,
   then write an experiment. Never guess a signature or a semantic.
6. After upgrading `effect`, diff the modules you depend on and re-run the
   experiments.

## Source links

- [Effect source at 4.1.2](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/Effect.ts)
- [Tests live in the repository, not in the package](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/effect/test): the best specification of edge-case behaviour.
