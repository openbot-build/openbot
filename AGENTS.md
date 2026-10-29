# Rules for working on OpenBot

## Commands

- Run every command as `devenv shell -- <command>`.

## Product

- OpenBot is headless and API first. Do not add a user interface, pages, or
  client apps. The only web site in the repository is the docs site in
  `packages/docs`.
- Command line tools go in `packages/cli` and the `openbot-*` command packages,
  such as `packages/computer`. They are tools, not a user interface.
- Command line tools go in `packages/cli` and the `openbot-*` command packages,
  such as `packages/computer`. They are tools, not a user interface.
- Build the docs site with Astro and Starlight only. Do not use Next.js or
  another web framework.
- Add a new feature to the HTTP contract in `@openbot-build/api` first. Then
  write the handler in `@openbot-build/openbot`. Make sure it works with an API
  key and with the same-origin session cookie.
- OpenBot provides model usage records, prices, credits, quotas, budgets, and
  rate limits. The server checks and applies these rules through the public API.
- Describe OpenBot on its own. Keep docs and project rules about its features
  and public contracts, without naming downstream products or repositories.

## Language

- Write all text that goes into the repository in
  [Basic English](https://en.wikipedia.org/wiki/Basic_English). This covers
  docs, comments, error messages, logs, prompts, test names, test data, and
  commit messages.
- These language rules are only for the repository. They do not cover your talk
  with the user. Answer the user in their language and in a normal style.
- Use the 850 words of Basic English where you can, plus the technical words you
  need. Use short sentences, one idea in each sentence, and active voice.
  Explain a technical word the first time you use it.
- English is the source language. Use another language only for translations on
  the docs site:
  - The docs are in English, Simplified Chinese (`zh-cn`), and German (`de`).
    Translations live in `packages/docs/content/docs/<locale>/`.
  - Keep the plain style of Basic English in every translation.
- The `LICENSE` file is the official legal text of the AGPL. Do not change it.

## License

- OpenBot uses `AGPL-3.0-only`, except `packages/client`, which uses MIT. New
  packages use `AGPL-3.0-only`. The client bundles the OpenBot code it needs;
  `packages/client/LICENSE` gives that code an added MIT grant. Keep third-party
  code under its own terms. Keep workspace imports for local development.
  `pnpm pack` makes the bundle; normal builds keep shared type identities across
  packages.
- Add a new dependency only when its license lets us share it under the AGPL.

## Docs

- All docs live on the docs site, as MDX pages in `packages/docs/content/docs`.
  Do not add other documentation files. The root `README.md` gives only a short
  overview.
- When you change how something works, update its page in the same change, in
  English, Chinese, and German.
- A translated page keeps the same headings in the same order as the English
  page, and links to pages in its own language.
- The API reference is made from the contract by `packages/docs/scripts/api.ts`.
  Do not edit it by hand.

## Code

- Use Effect immutable data structures first. Use mutable JavaScript structures
  only when you really need them.
- Put code in the folder of the feature it belongs to. Packages use each other
  only through their public entry points.
- Importing a module must not start any I/O.
- Follow the Effect rules on the contributing page of the docs. `pnpm typecheck`
  checks them with the Effect language service and with
  `scripts/effect-rules.ts`. Do not turn a rule off to save work. When code must
  stay native, turn the rule off for one line only, and give the reason after
  `--`.
- A service gets the services it needs when its layer is built. Its methods do
  not ask for other services, except for context of the request, such as
  `Identity`.
- A library layer asks for the platform services and the services of the outside
  world. Program entry points and tests give them. Do not use
  `Effect.serviceOption` to find a feature.
- Read values from the platform settings when you use them. Do not give them to
  a layer as arguments.
- Every fiber has an owner: a scope, a `FiberSet`, or a `FiberMap`. In
  `packages/openbot`, periodic work uses `Background.repeat`.
- Never drop the cause of a failure. A public HTTP error must not carry inside
  details, so log the inside failure first. In `packages/openbot`,
  `Failures.replace` does this.

## Changes

- When a change would need compatibility work for old callers, clients, or
  stored data, ask the user first. Do not decide alone between a breaking change
  and keeping old behavior.
- Never regenerate or change the baseline migration in
  `packages/openbot/migrations`. For each schema change, add a new migration
  with `drizzle-kit generate --name <change>`, so existing databases upgrade in
  place.
- When you must work around a bug in a dependency or a tool, explain the bug in
  a comment next to the workaround.

## Checks

- Before you finish, run `pnpm build`, `pnpm typecheck`, and the tests of the
  packages you changed (`pnpm --filter <package> test`).
