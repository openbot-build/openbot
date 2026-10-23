# OpenBot

OpenBot is an open source Agent platform with no user interface of its own. You use it through an HTTP API.

You give work to an Agent in plain language. OpenBot runs the work on a server, keeps the history, asks people before risky actions, and gives back results you can check. You bring the client: a script, a service, a chat bot, or your own app.

## Features

- **API first.** Every feature is an HTTP call. One typed contract makes the server, the TypeScript client, and the API reference.
- **User tokens.** Sign in once in a browser, make a token, and call the API from any program.
- **Organization and permissions.** Many people can share one OpenBot. Roles and policies decide what each person and each token may do.
- **Sessions and Timelines.** Work happens in Sessions and Turns. The Timeline keeps versions, so you can go back and try again.
- **Agent for Agents.** Your default Agent acts for you and gives work to a team of lasting Agents and their Session Agents. Each Agent has its own context and memory.
- **Lazy capabilities.** Agents have no preset limits. When an Agent tries something new, the decider above it answers, and Grants and Rules keep the answer.
- **Plans, todos and triggers.** An Agent can plan first and wait for approval, keep a todo list, and wait. A trigger starts its work on a schedule or from a webhook.
- **Channels.** People talk with an Agent in Slack, Lark, Telegram or their own chat system. Each Turn works for the person who wrote the message.
- **Open Apps.** Agents find and use Apps that publishers put on the open web with the OpenBot App Protocol.

## Quick start

You need [devenv](https://devenv.sh).

```sh
devenv shell -- pnpm dev:setup
devenv shell -- mkcert -install
devenv shell -- pnpm dev
```

OpenBot now runs at `https://localhost:8443` with a test account and test models. Sign in and make a user token:

```sh
curl -c cookies.txt -X POST -H 'Origin: https://localhost:8443' -H 'Content-Type: application/json' \
  -d '{}' https://localhost:8443/auth/development/sign-in
curl -b cookies.txt -H 'Origin: https://localhost:8443' -H 'Content-Type: application/json' \
  -d '{"name":"local"}' https://localhost:8443/v1/user/tokens
```

Then call the API with the `secret` from the answer:

```sh
curl -H "Authorization: Bearer $OPENBOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"My first Session"}' https://localhost:8443/v1/sessions
```

## Docs

The docs site is in [`packages/docs`](./packages/docs). Run it on your computer:

```sh
devenv shell -- pnpm --filter @openbot-build/docs dev
```

Then open `http://localhost:4321`. Start with the Intro and the Quick start.

## Packages

| Package                        | What it is                                           |
| ------------------------------ | ---------------------------------------------------- |
| `@openbot-build/openbot`       | The server, all its plugins, and its model providers |
| `@openbot-build/api`           | The typed HTTP contract                              |
| `@openbot-build/client`        | The TypeScript client                                |
| `@openbot-build/core`          | The Agent core                                       |
| `@openbot-build/protocol`      | The OpenBot App Protocol library                     |
| `@openbot-build/protocol-test` | A public test service for the App Protocol           |
| `@openbot-build/docs`          | The docs site                                        |

## Work on the code

```sh
devenv shell -- pnpm install
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm -r test
```

Read [AGENTS.md](./AGENTS.md) for the rules of the project.

## License

OpenBot is free software under the [GNU Affero General Public License, version 3 only](./LICENSE) (`AGPL-3.0-only`).

In short: you can use, change, and share OpenBot. If you share a changed copy, or let people use a changed copy over a network, you must give them the source code of your changes under the same license. The [LICENSE](./LICENSE) file has the full, legal text. Only that text decides what you can do.
