# OpenBot App Protocol Test Service

This service is a public test partner for the OpenBot App Protocol. It runs at the origin set in `PROTOCOL_TEST_PUBLIC_ORIGIN`. The examples use `https://protocol-test.example.com`. The service follows the OpenBot App Protocol V1.1 draft. It uses MCP `2026-07-28`, Streamable HTTP over HTTPS, and MCP Apps `2026-01-26`. When you build or test it on your computer, nothing goes to the public domain.

## Rules for test data

All accounts and secrets on this page are public and made up. Do not send private information.

Data does not last long:

- Workspaces end after 30 minutes.
- Access tokens end after 5 minutes.
- Refresh grants end after 1 hour.
- Authorization codes end after 1 minute.
- Consent requests end after 10 minutes.
- A restart clears all data.

Each scenario has its own MCP server and its own workspace store. In OAuth scenarios, each account also has its own workspaces. In the anonymous scenario and the header scenarios, all users share the made-up data of that scenario. So pick a workspace ID that nobody else uses.

## Find an App

You can start from any of these addresses:

- the domain, or `/`;
- `/.well-known/ai-catalog.json`;
- one App page at `/apps/<id>`;
- `/apps/<id>/catalog.json`;
- `/apps/<id>/server-card.json`.

App pages point to their Catalog in two ways: an HTML link tag and an HTTP `Link` header. A QR code must hold the same normal HTTPS App page URL. There is no special QR format.

Each Card has an icon, usage examples, and the live endpoint and version. The API Key Card also has a second remote. That remote uses a URL variable and a secret header variable, so you can test connection settings. Cards and Catalogs support conditional requests with `ETag` and `Last-Modified`.

`/scenarios.json` lists all scenarios and fixtures in a machine-readable form. `/healthz` and `/readyz` report status. They never run a business tool. `/guide` shows this guide.

Opening a discovery document never runs a tool. The host still runs its own steps to add, sign in, check permissions, and remove.

## Scenarios

| App ID                     | MCP path                        | Credentials                                                                                                                       |
| -------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous`                | `/mcp/anonymous`                | None                                                                                                                              |
| `api-key`                  | `/mcp/api-key`                  | `X-API-Key: protocol-test-api-key`                                                                                                |
| `bearer`                   | `/mcp/bearer`                   | `Authorization: Bearer protocol-test-bearer-token`                                                                                |
| `basic`                    | `/mcp/basic`                    | `Authorization: Basic cHJvdG9jb2wtdGVzdDpwcm90b2NvbC10ZXN0LXBhc3N3b3Jk` (user `protocol-test`, password `protocol-test-password`) |
| `oauth-cimd`               | `/mcp/oauth-cimd`               | Client ID Metadata Document and public PKCE                                                                                       |
| `oauth-dcr`                | `/mcp/oauth-dcr`                | Dynamic client registration, with public or confidential PKCE                                                                     |
| `oauth-preregistered`      | `/mcp/oauth-preregistered`      | A registered public or confidential client with PKCE                                                                              |
| `oauth-client-credentials` | `/mcp/oauth-client-credentials` | A confidential machine client                                                                                                     |

The API Key, Basic, and static Bearer scenarios test fixed headers that the user sets up. Standard MCP account sign-in uses the OAuth scenarios. Older MCP versions and the old HTTP+SSE transport are not part of OpenBot App Protocol V1.1.

## OAuth flows

Each OAuth mode has its own issuer at `/oauth/<mode>`. The modes are `cimd`, `dcr`, `preregistered`, and `client-credentials`. You can read the issuer metadata at three addresses:

- `/.well-known/oauth-authorization-server/oauth/<mode>`
- `/.well-known/openid-configuration/oauth/<mode>`
- `/oauth/<mode>/.well-known/openid-configuration`

The OpenID addresses describe the same OAuth endpoints. This service does not issue OpenID ID tokens.

Protected Resource Metadata is at `/.well-known/oauth-protected-resource/mcp/oauth-<mode>`. The 401 and 403 challenges point to it. The root document at `/.well-known/oauth-protected-resource` points to the CIMD scenario.

Token and authorization requests must send the exact `resource`, for example `https://protocol-test.example.com/mcp/oauth-cimd`. A token from one scenario does not work in another.

| Client ID                                               | Authentication        | Registered callbacks                                                                   |
| ------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| `https://protocol-test.example.com/clients/public.json` | `none`, CIMD          | `https://protocol-test.example.com/callback`                                           |
| `protocol-test-public`                                  | `none`                | Public `/callback`, `http://127.0.0.1:8765/callback`, `http://localhost:8765/callback` |
| `protocol-test-confidential-basic`                      | `client_secret_basic` | Public `/callback`                                                                     |
| `protocol-test-confidential-post`                       | `client_secret_post`  | Public `/callback`                                                                     |

Both confidential clients use the public secret `protocol-test-client-secret`. With Basic authentication, encode the client ID and secret with the OAuth form encoding rules.

To use any other callback, use a valid public CIMD document or dynamic registration. The service reads CIMD documents through the OpenBot App Protocol public network rules. These rules block private, loopback, and cloud metadata addresses.

Dynamic registration works only at `/oauth/dcr/register`. It returns a client ID that expires. It also returns a secret when you ask for one. The supported grants are `authorization_code` and `refresh_token`. Machine credentials have their own scenario.

### Sign in with a browser

Start at `/oauth/<mode>/authorize` with these parameters:

- `response_type=code`;
- the registered `client_id` and the exact `redirect_uri`;
- `resource`, `scope`, and `state`;
- an S256 `code_challenge` and `code_challenge_method=S256`.

A browser form lets you allow or deny access as Alice or Bob. The callback keeps `state` and adds `iss`. A code is tied to the account, client, redirect, scopes, issuer, and resource. You can use it once at `/oauth/<mode>/token`, together with the PKCE verifier. You never sign in to a real service.

### Scopes and tokens

- `test:read` allows discovery and reads.
- `test:write` adds `write_note` and `delete_note`. Ask for both scopes to write.

Lists with read access only hide the write tools. A direct write without `test:write` gets 403 and names the needed scope. A missing, invalid, expired, revoked, or wrong-resource token gets 401.

A refresh gives a new refresh token. It cannot add scopes. `/oauth/<mode>/revoke` revokes the whole token family, including older access tokens. Unknown tokens never reveal anything about a grant.

Example machine token request:

```sh
curl https://protocol-test.example.com/oauth/client-credentials/token \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id=protocol-test-confidential-post \
  --data-urlencode client_secret=protocol-test-client-secret \
  --data-urlencode resource=https://protocol-test.example.com/mcp/oauth-client-credentials \
  --data-urlencode scope='test:read test:write'
```

Tokens are opaque strings. The service does not offer JWT assertion grants, DPoP, mTLS, outside company sign-in, payment or plan checks, or identity federation. The OpenBot App Protocol draft does not need them.

## MCP tests

`server/discover` reports the live capabilities. The service uses standard MCP messages, metadata, and errors. It adds no extra message wrapper.

| Tool                                | What it tests                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo`, `add`                       | Checked inputs, output schemas, clear text, and structured results                                                                                       |
| `identity`                          | The current made-up subject, the scenario, and the client capabilities. It never returns credentials.                                                    |
| `content_samples`                   | Text, image, audio, embedded resource, and resource link content                                                                                         |
| `read_workspace`                    | Reads a temporary workspace and opens its App view                                                                                                       |
| `write_note`                        | Creates a note from `workspace`, `text`, and `idempotencyKey`. A repeat with the same key returns the first receipt. A key reused with other data fails. |
| `delete_note`                       | Deletes a note by `workspace`, `id`, and `expectedRevision`. An old revision fails.                                                                      |
| `ui_read_workspace`                 | A tool only for the App view. The host enforces visibility, and the service still checks account permissions.                                            |
| `test_error`                        | A business failure on purpose, with `isError`                                                                                                            |
| `wait`                              | A short delay with progress and logs. Stop its HTTP request to test cancelling.                                                                          |
| `notify`                            | Sends list-change notifications for subscription tests                                                                                                   |
| `request_form`, `request_url`       | Form input and URL input through the standard keyed input flow                                                                                           |
| `request_sampling`, `request_roots` | Client sampling and root list input through the same flow                                                                                                |

The input tools take `{ "text": "A synthetic request" }`. Declare the matching client capabilities. Keep the opaque `requestState` you get back. Return the keyed `input` answer exactly, through the standard `inputResponses`.

These follow-up requests end after 5 minutes. Each one is tied to the scenario, account, tool, and original text. Unknown, reused, or mismatched requests fail. A form answer needs a `label` that is not empty. Declining or cancelling returns the standard result. No input tool writes business data. The URL page only confirms that the host opened it. The host decides whether to accept.

You can read these resources:

- `protocol-test://about`
- `protocol-test://binary`
- `protocol-test://workspace/<workspace>`
- `protocol-test://fixture/0` to `protocol-test://fixture/109`

There are 113 listed resources, so you can test cursor paging. The workspace template supports completion. The `summarize_workspace` prompt takes workspace and style arguments, with completion.

Unknown tools or resources, bad input, and unsupported methods return standard MCP errors. MCP subscriptions send resource updates after writes, and list changes from `notify`. Request metadata controls progress and logs. No background heartbeat is needed.

### App view

`ui://protocol-test/workspace.html` uses the MCP Apps MIME type and standard UI metadata. It loads no outside files and connects to no outside domains. It uses the official SDK client to test:

- start-up, and showing an existing result;
- host context;
- App-only and normal tool calls, and resource reads;
- model context updates and user messages;
- outside links;
- fullscreen and inline requests, size changes, and teardown.

Each action needs a clear button press. Showing a result never runs its write again. Hosts without view support can use the text and structured results.

## Discovery and indexing fixtures

Use `/fixtures/<id>/server-card.json`:

| ID              | What you should see                                             |
| --------------- | --------------------------------------------------------------- |
| `noindex`       | A Card listed in the root Catalog, with `X-Robots-Tag: noindex` |
| `robots-denied` | A Card listed in the root Catalog, blocked by `/robots.txt`     |
| `unlisted`      | A valid Card that is not in the publisher's Catalog             |
| `withdrawn`     | 410 Gone                                                        |
| `malformed`     | Broken JSON with the Card media type                            |
| `incompatible`  | A Card with only an unsupported protocol version and transport  |
| `redirect`      | A redirect to the anonymous Card                                |
| `unavailable`   | 503 with `Retry-After`                                          |

Public indexing must use only public, anonymous publisher evidence. It must keep exclusion, withdrawal, and unconfirmed results apart. Private grants, tools, results, and workspaces never go into the Catalog.

## Run and check

From the repository root:

```sh
devenv shell -- pnpm --filter @openbot-build/protocol build
devenv shell -- pnpm --filter @openbot-build/protocol-test build
devenv shell -- pnpm --filter @openbot-build/protocol-test test
devenv shell -- pnpm --filter @openbot-build/protocol-test start
```

| Setting                                           | Default           | Purpose                                          |
| ------------------------------------------------- | ----------------- | ------------------------------------------------ |
| `PROTOCOL_TEST_PUBLIC_ORIGIN`                     | Required          | The exact public HTTPS origin                    |
| `PROTOCOL_TEST_HOST`                              | `0.0.0.0`         | The address to listen on                         |
| `PROTOCOL_TEST_PORT`                              | `3001`            | The port to listen on                            |
| `PROTOCOL_TEST_ALLOWED_ORIGINS`                   | The public origin | Exact HTTPS browser origins, separated by commas |
| `PROTOCOL_TEST_TLS_KEY`, `PROTOCOL_TEST_TLS_CERT` | Not set           | Set both to serve HTTPS directly                 |

Most of the time the service speaks HTTP behind a TLS reverse proxy. For a local HTTPS test, set `PROTOCOL_TEST_PUBLIC_ORIGIN=https://localhost:7445`, set the port to `7445`, and set the key and certificate paths. Then make the host trust the development certificate.

Server clients do not send a browser `Origin` header, so they always work. Browser clients must have their exact origin in `PROTOCOL_TEST_ALLOWED_ORIGINS`. Preflight responses allow the MCP and authorization headers.

### Docker and Compose

Build the image:

```sh
devenv shell -- docker build -f docker/protocol-test.Dockerfile -t openbot/protocol-test .
```

Run it with Compose:

```sh
devenv shell -- docker compose -f compose.protocol-test.yaml up -d --build
```

The Compose service listens for HTTP on the loopback address only. `docker/protocol-test.nginx.conf` is an example HTTP origin behind a proxy that ends TLS. It keeps the `Host` header and passes on the outside scheme and client addresses. It turns off response buffering and caching for MCP streams.

After you set up DNS and TLS, check `/healthz`, the Catalog, and `server/discover` through the real HTTPS host name. Run only one copy. The made-up data lives in one process on purpose. Replacing the process removes test grants and follow-up requests.

### CI/CD

GitLab CI builds the protocol test image in the `build` stage, next to Platform. On every branch it starts the AMD64 image and checks health, the public Catalog identity, and anonymous MCP discovery. Pushes to the default branch and release tags publish `$CI_REGISTRY_IMAGE/protocol-test:<commit-sha>`, plus `:latest` or the version tag.

The production Compose file (`compose.production.yaml`) runs the test service without Platform credentials or a database. It listens only on `127.0.0.1:3001`. Put it behind a reverse proxy that supports streaming, at `PROTOCOL_TEST_PUBLIC_ORIGIN`. `PROTOCOL_TEST_ALLOWED_ORIGINS` can list allowed browser origins, separated by commas. It defaults to the public origin. Replacing the container clears its temporary data.
