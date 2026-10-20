---
compatibility: Examples target effect@4.0.0; Effect v3 requires migration.
description: Use when encoding or decoding bytes and text, handling Base64, Hex, YAML, TOML, SSE, NDJSON, cryptography, or JSON patch boundaries in Effect.
metadata:
  github-path: skills/effect-encoding
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: a9e044774602650f392c954f916c87fddab191c8
name: effect-encoding
---

# Effect encoding and cryptographic boundaries

Use the `effect/encoding` barrel for `Base64`, `Base64Url`, `Hex`, and
`EncodingError`. The same entrypoint also exposes the unstable Ini, Ndjson,
SchemaBinary, Sse, Toml, and Yaml modules. Pair them with Crypto or JsonPatch
only when signing or patching is part of the wire protocol.

## Make the wire format explicit

Choose an encoding based on the protocol, not convenience. Base64Url is not
interchangeable with Base64, and text encodings must declare their character
set. A decoder should return a typed error rather than silently replacing
invalid bytes.

```ts
import { Effect } from "effect";
import { Base64Url } from "effect/encoding";

const decodeToken = (token: string) =>
  Effect.fromResult(Base64Url.decodeString(token)).pipe(
    Effect.mapError((cause) => ({ _tag: "InvalidToken" as const, cause })),
  );
```

`Base64Url.decodeString` returns a `Result`; `Effect.fromResult` raises its
typed `EncodingError` in an Effect before mapping it to the domain error.

## Serialization and streaming

Use NDJSON and SSE when records arrive incrementally; do not collect an
unbounded input merely to parse it. Use SchemaBinary or a Schema-backed
format when both validation and serialization must be versioned. Preserve
record boundaries and reject trailing garbage when the protocol requires a
single document.

## Crypto and patch safety

Keep key material in a secret service and use Crypto through a Layer or
platform adapter. Authenticate before applying a JsonPatch supplied by an
untrusted caller, validate the path policy, and record the expected document
version. Encoding is not encryption and Base64 is not a security boundary.

## Review traps

- Decoding a user-controlled payload before applying size limits.
- Treating malformed UTF-8 as harmless replacement text.
- Applying JSON patches to a mutable shared object without a version check.
- Logging encoded credentials or ciphertext that is still sensitive.
- Mixing v3 and v4 module paths; encoding subpaths are unstable in v4.

## References

- [Base64Url API](https://effect.website/docs/v4/api/effect/encoding/Base64Url)
- [Pinned Base64Url source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/encoding/Base64Url.ts)
- [Pinned EncodingError source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/encoding/EncodingError.ts)
- [JsonPatch API](https://effect.website/docs/v4/api/effect/JsonPatch)
- [Crypto API](https://effect.website/docs/v4/api/effect/Crypto)
- [Effect source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/encoding)
