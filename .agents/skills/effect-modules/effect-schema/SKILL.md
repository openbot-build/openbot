---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when validating untrusted values, modeling structured domain variants, or defining reversible wire/domain codecs with Effect Schema.
metadata:
  github-path: skills/effect-schema
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: aa17eea16c9f7ad0767fc453ce7f597b3ae1d4a9
name: effect-schema
---

# Effect Schema

Use Schema at an untrusted boundary: HTTP bodies, configuration, queues,
files, database rows, and external SDK responses. This skill covers the core
Schema module plus SchemaAST, SchemaGetter, SchemaIssue, SchemaParser,
SchemaRepresentation, SchemaTransformation, StandardSchema, JsonSchema, and
the unstable schema compiler modules.

## Decode at the boundary

Keep unknown data unknown until a schema has decoded it. The decoded type
should be the input to domain code; do not duplicate the schema as a hand
written TypeScript interface and a second validator.

```ts
import { Effect, Schema } from "effect";

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.Literals(["admin", "member"]),
});

const decodeUser = Schema.decodeUnknownEffect(User);
const input: unknown = { id: "u1", name: "Ada", role: "member" };

const program = decodeUser(input).pipe(Effect.map((user) => user.name));
```

When the boundary is synchronous, use the corresponding synchronous decoder
only if the schema has no effectful transformations. Keep Schema.SchemaError
and its issue path structured until the HTTP or CLI layer chooses a response
format.

## Model domain variants

Prefer tagged unions and Schema.Class for domain values with stable tags. Put
refinements and brands close to the field they protect. Use transformations
when wire and domain representations are intentionally different, and test
both decode and encode directions.

SchemaAST and SchemaRepresentation are inspection tools. SchemaParser and
SchemaIssue are useful when building a custom error renderer. JsonSchema and
StandardSchema are interoperability boundaries; do not assume every Effect
transformation can be represented in JSON Schema.

Stable 4.0.0 makes `Schema.brand` type-only and accepts one concrete brand
identifier per call. Apply it repeatedly for multiple brands, pass an enum
member rather than its string value, and reapply it after rebuilding a
`SchemaRepresentation`; `Schema.fromBrand` still carries the constructor's
checks.

## Review checklist

- Is unknown input decoded exactly once?
- Are optional, nullable, and missing fields distinguished?
- Does encode produce the documented wire representation?
- Are secret fields redacted before errors, logs, or telemetry?
- Is a compiler/JIT optimization isolated behind the unstable API and pinned
  to a compatible Effect version?

## Common mistakes

- Trusting a TypeScript cast or JSON.parse result.
- Using a refinement for a side effect or an asynchronous lookup.
- Treating a parse issue as an exception and losing its path information.
- Generating JSON Schema for a schema whose transformation cannot be
  expressed in JSON Schema.
- Copying v3 Schema constructors into a v4 project.

## References

- [Schema API](https://effect.website/docs/v4/api/effect/Schema)
- [SchemaParser API](https://effect.website/docs/v4/api/effect/SchemaParser)
- [SchemaTransformation API](https://effect.website/docs/v4/api/effect/SchemaTransformation)
- [JsonSchema API](https://effect.website/docs/v4/api/effect/JsonSchema)
- [Effect Schema guide](https://effect.website/docs)
- [Pinned Schema source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/Schema.ts)
