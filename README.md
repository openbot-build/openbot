# OpenBot

OpenBot is an open source Agent platform with no user interface of its own. You use it through an HTTP API.

You give work to an Agent in plain language. OpenBot runs the work on a server, keeps the history, asks people before risky actions, and gives back results you can check. You bring the client: a script, a service, a chat bot, or your own app.

## Features

- **API first.** Every feature is an HTTP call. One typed contract makes the server, the TypeScript client, and the API reference.
- **API keys.** Sign in once in a browser, make a key, and call the API from any program.
- **Sessions and Memory.** Work happens in Sessions and Turns. Memory keeps versions, so you can go back and try again.
- **Approvals.** Risky tool calls wait until a person says yes.
- **Open Apps.** Agents find and use Apps that publishers put on the open web with the OpenBot App Protocol.

## Quick start

You need [Docker](https://docs.docker.com/get-docker/) and [devenv](https://devenv.sh).

```sh
devenv shell -- pnpm dev:setup
devenv shell -- mkcert -install
devenv shell -- pnpm dev
```

OpenBot now runs at `https://localhost:8443` with a test account and test models. Sign in and make an API key:

```sh
curl -c cookies.txt https://localhost:8443/auth/login
curl -b cookies.txt -H 'Origin: https://localhost:8443' -H 'Content-Type: application/json' \
  -d '{"name":"local"}' https://localhost:8443/auth/api-keys
```

Then call the API with the `secret` from the answer:

```sh
curl -H "Authorization: Bearer $OPENBOT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"title":"My first Session"}' https://localhost:8443/v1/sessions
```

## Docs

The docs site is in [`packages/docs`](./packages/docs). Run it on your computer:

```sh
devenv shell -- pnpm --filter @openbot-build/docs dev
```

Then open `http://localhost:3000/docs`. Start with the Intro and the Quick start.

## Packages

| Package                        | What it is                                           |
| ------------------------------ | ---------------------------------------------------- |
| `@openbot-build/platform`      | The server                                           |
| `@openbot-build/platform-api`  | The typed HTTP contract                              |
| `@openbot-build/client`        | The TypeScript client                                |
| `@openbot-build/core`          | The Agent core                                       |
| `@openbot-build/protocol`      | The OpenBot App Protocol library                     |
| `@openbot-build/app-host`      | Contracts for hosts that use Apps                    |
| `@openbot-build/plugin-*`      | Plugins for goals, memory, and Turn limits           |
| `@openbot-build/provider-*`    | Model providers: OpenAI, Chat Completions, Anthropic |
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
