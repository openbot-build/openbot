# OpenBot

OpenBot is an open source Bot platform with no user interface of its own. You
use it through an HTTP API.

You give work to a Bot in plain language. OpenBot runs the work on a server,
keeps the history, asks people before risky actions, and gives back results you
can check. You bring the client: a script, a service, a chat bot, or your own
app.

## Features

- **API first.** Every feature is an HTTP call. One typed contract makes the
  server, the TypeScript client, and the API reference.
- **User tokens.** Sign in once in a browser, make a token, and call the API
  from any program.
- **Organization and permissions.** Many people can share one OpenBot. Roles and
  policies decide what each person and each token may do.
- **Chats and Turns.** Work happens in Chats. Each message starts a Turn or
  joins the Turn that runs, and OpenBot keeps the history.
- **Bot for Bots.** Your default Bot acts for you and gives work to other Bots
  through delegation. Each Bot has its own context and memory.
- **Lazy capabilities.** Bots have no preset limits. When a Bot tries something
  new, the decider above it answers, and Grants and Rules keep the answer.
- **Plans, todos and triggers.** A Bot can plan first and wait for approval,
  keep a todo list, and wait. A trigger starts its work on a schedule or from a
  webhook.
- **Channels.** People talk with a Bot in Slack, Lark, Telegram or their own
  chat system. Each Turn works for the person who wrote the message.
- **Live mode.** People talk with a Bot in real time, with sound, over one
  WebSocket. Each thing they say is a normal Turn.
- **Open Apps.** Bots find and use Apps that publishers put on the open web with
  the OpenBot App Protocol.

## Quick start

You need [devenv](https://devenv.sh) 2.3 or newer and a running
[Docker](https://docs.docker.com/get-docker/) service.

```sh
devenv shell -- pnpm dev:setup
devenv shell -- pnpm dev
```

OpenBot now runs at `http://localhost` with a test account and test models. Sign
in and make a user token:

```sh
curl -c cookies.txt -X POST -H 'Origin: http://localhost' -H 'Content-Type: application/json' \
  -d '{}' http://localhost/auth/development/sign-in
curl -b cookies.txt -H 'Origin: http://localhost' -H 'Content-Type: application/json' \
  -d '{"name":"local"}' http://localhost/v1/user/tokens
```

Then call the API with the `secret` from the answer. The
[developer quick start](https://docs.openbot.build/developers/quickstart) makes
a Bot and sends it a message.

## Docs

Read the docs at [docs.openbot.build](https://docs.openbot.build). The source is
in [`packages/docs`](./packages/docs). Run it on your computer:

```sh
devenv shell -- pnpm --filter @openbot-build/docs dev
```

Then open `http://localhost:4321`. Start with the Intro and the Quick start.

## Packages

| Package                                | What it is                                        |
| -------------------------------------- | ------------------------------------------------- |
| `@openbot-build/openbot`               | The server and its plugin host                    |
| `@openbot-build/server-database`       | The server database tables and migrations         |
| `@openbot-build/server-kernel`         | The shared parts of the server                    |
| `@openbot-build/identity-contract`     | Shared tags and types for sign-in and access      |
| `@openbot-build/server-billing`        | Billing and limits of the server                  |
| `@openbot-build/server-execution`      | The execution engine of the server                |
| `@openbot-build/tools-contract`        | Shared tags and types for tools                   |
| `@openbot-build/models-contract`       | Shared tags and types for models                  |
| `@openbot-build/apps-contract`         | Shared tags and types for Apps, files, and vaults |
| `@openbot-build/conversation-contract` | Shared tags and types for Bots and Chats          |
| `@openbot-build/model-providers`       | The model providers of the server                 |
| `@openbot-build/server-plugin`         | The plugin kit of the server                      |
| `@openbot-build/plugin-audit`          | The `audit` plugin of the server                  |
| `@openbot-build/plugin-mail`           | The `mail` plugin of the server                   |
| `@openbot-build/plugin-platform`       | The `platform` plugin of the server               |
| `@openbot-build/plugin-organization`   | The `organization` plugin of the server           |
| `@openbot-build/plugin-access`         | The `access` plugin of the server                 |
| `@openbot-build/plugin-sso`            | The `sso` plugin of the server                    |
| `@openbot-build/plugin-auth`           | The `auth` plugin of the server                   |
| `@openbot-build/plugin-authorization`  | The `authorization` plugin of the server          |
| `@openbot-build/plugin-models`         | The `models` plugin of the server                 |
| `@openbot-build/plugin-files`          | The `files` plugin of the server                  |
| `@openbot-build/plugin-bots`           | The `bots` plugin of the server                   |
| `@openbot-build/plugin-capabilities`   | The `capabilities` plugin of the server           |
| `@openbot-build/plugin-work`           | The `work` plugin of the server                   |
| `@openbot-build/plugin-chats`          | The `chats` plugin of the server                  |
| `@openbot-build/plugin-channels`       | The `channels` plugin of the server               |
| `@openbot-build/plugin-apps`           | The `apps` plugin of the server                   |
| `@openbot-build/plugin-code`           | The `code` plugin of the server                   |
| `@openbot-build/plugin-artifacts`      | The `artifacts` plugin of the server              |
| `@openbot-build/plugin-vaults`         | The `vaults` plugin of the server                 |
| `@openbot-build/plugin-computers`      | The `computers` plugin of the server              |
| `@openbot-build/plugin-triggers`       | The `triggers` plugin of the server               |
| `@openbot-build/plugin-billing`        | The `billing` plugin of the server                |
| `@openbot-build/plugin-settings`       | The `settings` plugin of the server               |
| `@openbot-build/plugin-turn-limiter`   | The `turn-limiter` plugin of the server           |
| `@openbot-build/plugin-time-limiter`   | The `time-limiter` plugin of the server           |
| `@openbot-build/plugin-token-limiter`  | The `token-limiter` plugin of the server          |
| `@openbot-build/server-development`    | The development server                            |
| `@openbot-build/server-testing`        | Test helpers and host tests of the server         |
| `@openbot-build/api`                   | The typed HTTP contract                           |
| `@openbot-build/client`                | The TypeScript client                             |
| `@openbot-build/core`                  | The Bot core                                      |
| `@openbot-build/domain`                | The shared domain types and rules                 |
| `@openbot-build/protocol`              | The OpenBot App Protocol library                  |
| `@openbot-build/protocol-test`         | A public test service for the App Protocol        |
| `@openbot-build/cli`                   | The `openbot` command                             |
| `@openbot-build/computer`              | Pairs and connects your own machine as a Computer |
| `@openbot-build/docs`                  | The docs site                                     |

## Work on the code

```sh
devenv shell -- pnpm install
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm -r test
```

Read [AGENTS.md](./AGENTS.md) for the rules of the project.

## License

OpenBot is free software under the
[GNU Affero General Public License, version 3 only](./LICENSE)
(`AGPL-3.0-only`).

In short: you can use, change, and share OpenBot. If you share a changed copy,
or let people use a changed copy over a network, you must give them the source
code of your changes under the same license. The [LICENSE](./LICENSE) file has
the full, legal text. Only that text decides what you can do.

The client package uses MIT, including the OpenBot code bundled with it. See
[the client license](./packages/client/LICENSE). Other packages keep AGPL.
