# Rules for working on OpenBot

## Commands

- Run every command as `devenv shell -- <command>`.

## Product

- OpenBot is headless and API first. Do not add a user interface, pages, or client apps. The only web site in the repository is the docs site in `packages/docs`.
- Add a new feature to the HTTP contract in `@openbot-build/platform-api` first. Then write the handler in `@openbot-build/platform`. Make sure it works with an API key and with the same-origin session cookie.

## Language

- Write all text in [Simple English](https://en.wikipedia.org/wiki/Simple_English). This covers docs, comments, error messages, logs, prompts, test names, test data, and commit messages.
- Use short sentences, common words, one idea in each sentence, and active voice. Explain a technical word the first time you use it.
- Do not use any other language in the repository.

## Docs

- All docs live on the docs site, as MDX pages in `packages/docs/content/docs`. Do not add other documentation files. The root `README.md` gives only a short overview.
- When you change how something works, update its page in the same change.
- The API reference is made from the contract by `packages/docs/scripts/api.ts`. Do not edit it by hand.

## Code

- Use Effect immutable data structures first. Use mutable JavaScript structures only when you really need them.
- Put code in the folder of the feature it belongs to. Packages use each other only through their public entry points.
- Importing a module must not start any I/O.

## Changes

- Do not keep old behavior for old callers, clients, or stored data. Make the breaking change and keep one current model.
- When you must work around a bug in a dependency or a tool, explain the bug in a comment next to the workaround.

## Checks

- Before you finish, run `pnpm build`, `pnpm typecheck`, and the tests of the packages you changed (`pnpm --filter <package> test`).
