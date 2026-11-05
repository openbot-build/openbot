# Composing modules

Select a skill by the decision being made, not simply by an imported symbol.
Every skill stands alone after installation; these combinations are optional
paths through related responsibilities. All module paths below are for the
[pinned 4.1.2 release](https://github.com/nmnmcc/effect-skills/blob/main/docs/version-policy.md).

| Decision | Primary skill | Adjacent responsibility |
| --- | --- | --- |
| Describe execution, errors, and a run boundary | [core](core/guide.md) | [services](services/guide.md) provides dependencies and Scope |
| Assemble dependencies and scoped clients | [services](services/guide.md) | [config](config/guide.md) loads settings; [platform](platform/guide.md) supplies runtime adapters |
| Coordinate fibers and bounded queues | [concurrency](concurrency/guide.md) | [streams](streams/guide.md) owns incremental pipelines; [time](time/guide.md) owns scheduling |
| Update in-process state atomically | [state](state/guide.md) | [reactivity](reactivity/guide.md) connects atoms to UI; [persistence](persistence/guide.md) survives restarts |
| Represent absence or pure data | [data](data/guide.md) | [schema](schema/guide.md) proves untrusted representations |
| Validate or transform external values | [schema](schema/guide.md) | [encoding](encoding/guide.md) handles bytes/text; [config](config/guide.md) describes application settings |
| Send or serve ordinary HTTP | [HTTP](http/guide.md) | [HTTP API](http-api/guide.md) adds endpoint contracts and OpenAPI |
| Define typed remote procedures | [RPC](rpc/guide.md) | [cluster](cluster/guide.md) routes entity IDs to owners |
| Query relational records and transact | [SQL](sql/guide.md) | [persistence](persistence/guide.md) owns key-value/cache/queue abstractions |
| Resume a named job after restart | [workflow](workflow/guide.md) | [persistence](persistence/guide.md) backs engine/queues; [eventlog](eventlog/guide.md) records domain events |
| Emit operational signals | [observability](observability/guide.md) | [testing](testing/guide.md) proves behavior without live exporters |
| Parse an interactive command | [CLI](cli/guide.md) | [platform](platform/guide.md) owns process lifecycle |
| Call models or expose tools | [AI](ai/guide.md) | [schema](schema/guide.md) validates tools/output; [services](services/guide.md) provides clients |

## Common composition paths

### HTTP API backed by SQL

[schema](schema/guide.md) defines request, response, and public error schemas;
[http-api](http-api/guide.md) binds them to routes and generated clients;
[services](services/guide.md) keeps handlers dependent on a `Users` capability;
[sql](sql/guide.md) implements that capability with parameterized statements and a
scoped client; [platform](platform/guide.md) runs the server. Use [http](http/guide.md) directly
for transport details or a client without a typed API contract. Decode at
the HTTP boundary, translate expected domain failures to declared status
codes, and keep SQL and connection lifetime outside individual requests.

The checked [implementation](https://github.com/nmnmcc/effect-skills/blob/main/examples/user-api.ts) and
[test](https://github.com/nmnmcc/effect-skills/blob/main/examples/user-api.test.ts) create a user over HTTP (201), fetch it
(200), reject an invalid body (400), return a typed missing-user error (404),
and reopen a file-backed database before fetching the same user again. Run
`devenv shell -- npm test` after `npm ci` to exercise the full path.

### Validate external data

Use [encoding](encoding/guide.md) to decode the declared byte/text format, then
[schema](schema/guide.md) to turn `unknown` into a domain value. Use [data](data/guide.md) for
pure absence and variants after decoding. [config](config/guide.md) is the separate
boundary for environment settings and secrets: evaluate it at startup and
inject the resolved value via [services](services/guide.md). Test malformed, missing,
optional, and transformed inputs without a type cast.

### Provide a service graph

Define a `Context.Service` capability in [services](services/guide.md); provide one
scoped `Layer` composed from [config](config/guide.md) and the selected
[platform](platform/guide.md), HTTP, or SQL adapter. Domain Effects retain their service
requirement. [testing](testing/guide.md) substitutes a deterministic Layer and checks
construction failure, interruption, and finalization. Run only at the host
boundary described by [core](core/guide.md).

### Select persistence

Choose [state](state/guide.md) for process-local atomic values, [sql](sql/guide.md) for
relational queries/transactions, and [persistence](persistence/guide.md) for a key-value
store, persisted cache/queue, or shared rate limiter. [workflow](workflow/guide.md)
adds restart-surviving execution identity and replay; [eventlog](eventlog/guide.md)
adds append-only facts and replayable handlers; [cluster](cluster/guide.md) assigns
sharded entity ownership. A memory Layer only proves wiring, never durability
or cross-process delivery. Version persisted schemas and make redelivered
external writes idempotent.
