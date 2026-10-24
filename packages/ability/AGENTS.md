# Rules for working on @nmnmcc/ability

This repository is a TypeScript authorization library. Authorization means the
work of deciding if a principal may do an act. It is made with Effect only. Its
ideas come from Effect, CASL and XACML, but it does not use CASL.

These rules are for the whole repository. An `AGENTS.md` file in a folder can
give more exact rules for that folder. The `references/` folder is reference
material. Do not change it unless the user asks.

## Commands

- Run every command as `devenv shell -- <command>`.
- Format with `devenv shell -- treefmt`. It runs Prettier and nixfmt. The shell
  also runs treefmt when it starts.

## Language

- Write all text that goes into the repository in Basic English. This covers
  docs, comments, error messages, logs, prompts, test names, test data, and
  commit messages.
- Use the 850 words of Basic English where you can, plus the technical words you
  need. Use short sentences, one idea in each sentence, and active voice.
  Explain a technical word the first time you use it.

## Project Shape

- The package manager is `pnpm`. The exact version is in `package.json`.
- The development shell comes from [devenv](https://devenv.sh), in `devenv.nix`.
  It gives Node.js, pnpm (through corepack), and treefmt.
- The type checker is TypeScript 7 (`tsgo`) with the Effect language service
  from `@effect/tsgo`. `pnpm install` runs `effect-tsgo patch`, which puts the
  Effect checks into `tsc`. The check levels are in `tsconfig.json`.
- Source files import each other with `.ts` extensions. Node.js runs `.ts` files
  itself, so the examples need no other runner.
- Public entry points: `src/index.ts`, and one module for each concept:
  `Resource`, `Principal`, `Domain`, `Condition`, `Rule`, `Policy`, `Decision`,
  `Authorizer`.
- `src/HttpApi.ts` is a separate entry point, because `effect/http-api` is not
  stable. Do not export it from `src/index.ts`.
- Internal code is in `src/internal/`, with one file for each module that has
  code.
- Examples are in `examples/`.
- Tests are in `tests/`.

## Public API

- Use Effect module functions and data that does not change. Do not make a class
  with changing state.
- All types come from the `Domain`. A rule may only use the actions of its
  resource, and a condition may only use the fields of its resource and of the
  principal. Keep these checks in the types.
- `Resource.Class` works like `Schema.TaggedClass`. Every resource value has a
  `_tag`. Do not find a resource from a constructor name.
- `Policy.define()` is pure and synchronous. A `Rule` must work with generators,
  so users can write `yield* _.allow(...)`.
- A condition is plain data. Only a predicate may run code. A predicate keeps
  its error type and service type in the types of the policy and of every check.
  A policy with a predicate must not become JSON: keep the `Opaque` marker in
  the types.
- A decision is `Allow`, `Deny` or `NotApplicable`. `Policy.decide` gives a
  decision. `Authorizer.check` puts a "no" into the error channel.
- Fail closed. An error while loading a policy is never a "yes".
- `Policy.residual` must agree with `Policy.decide`. The property tests in
  `tests/Policy.test.ts` check this. Add a case there when you add an algorithm,
  a combinator, or a kind of condition node.

## Code

- Keep public types and their docs in the public modules in `src/`. Keep the
  code in `src/internal/`.
- Inside `src/internal/`, the error and service types of predicates are erased
  to `unknown`. Those files turn off the `anyUnknownInErrorContext` check. Keep
  the real types in the public modules.
- Follow the style of the code near your change before you add new layers.
- Keep each change to what the user asked for.
- Do not change generated files or reference material by hand.
- When you must work around a bug in a dependency or a tool, explain the bug in
  a comment next to the workaround.

## Dependencies

- Pin each dependency to an exact version.
- pnpm does not install very new releases. Do not add `minimumReleaseAgeExclude`
  entries to get around this.

## Checks

Use `@effect/vitest` for tests. Type tests use `tstyche`.

```sh
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test-types
devenv shell -- node examples/basic.ts
devenv shell -- node examples/authorizer.ts
devenv shell -- node examples/openbot-rbac.ts
git diff --check
```

- Run `pnpm typecheck` after a change to types or to the public API. An error
  from the Effect language service makes the typecheck fail.
- Run `pnpm test` after a change to behavior.
- Run `pnpm test-types` after a change to public types.
- Run the examples after a change to an example or to an API in the README.
- For a change to docs only, `git diff --check` is enough, unless a code example
  in the docs changed.

## Work

- Read the files before you change code.
- Use `rg` to search.
- Do not undo changes that the user made, or other changes you did not make.
- When a sandbox stops an important command, ask for the right permission and
  run it again.
- Say which checks you ran. Do not say that a check passed when you did not run
  it.
