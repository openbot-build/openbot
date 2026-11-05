# Crypto and JSON patch recipes

The `effect/crypto` module (new in 4.1, marked unstable) replaces the old
single `Crypto` service with one small service per concern, each built on Web
Crypto (`globalThis.crypto`), so the same code runs on Node, Bun, Deno and
browsers. Import the namespaces from `"effect/crypto"`:

| Need | Service | Layer |
| --- | --- | --- |
| SHA-1/256/384/512 and MD5 hashes | `Digest.Digest` | `Digest.layerWebCrypto` |
| secure random bytes, ints, shuffles, UUID v4/v7, ULID | `SecureRandom.SecureRandom` | `SecureRandom.layerWebCrypto` |
| HMAC sign / constant-time verify | `Mac.Mac` | `Mac.layerWebCrypto` (needs `SecureRandom`) |
| password / key derivation (HKDF, PBKDF2, Argon2id) | `Kdf.Kdf` | `Kdf.layerWebCrypto` |
| authenticated encryption (AES-GCM, ChaCha20-Poly1305) | `Aead.Aead` | `Aead.layerWebCrypto` |
| signatures (Ed25519, ECDSA, RSA-PSS) | `Signature.Signature` | `Signature.layerWebCrypto` |

`@effect/platform-node` also ships `NodeCrypto.layer`, which provides all of them
backed by `node:crypto` where that is faster (and adds Argon2id support). Note that
`NodeServices.layer` no longer includes crypto: provide `NodeCrypto.layer` or the
`effect/crypto` layers you need explicitly. Domain code depends on the service
(`Mac.Mac`), never on a layer.

## Hashes and random IDs

```ts import.meta.vitest name="references/encoding/crypto-and-patch.md#1"
import { Effect, Layer } from "effect"
import { Digest, SecureRandom } from "effect/crypto"

const fingerprint = (text: string) =>
  Effect.gen(function*() {
    const digest = yield* Digest.Digest
    return yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(text))
  })

const newId = Effect.gen(function*() {
  const random = yield* SecureRandom.SecureRandom
  return yield* random.uuidV4()
})

const live = Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto)

const hex = await Effect.runPromise(fingerprint("abc").pipe(Effect.provide(live)))
hex // => "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

// Real randomness has the right shape but never a fixed value.
const id = await Effect.runPromise(newId.pipe(Effect.provide(live)))
const isV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) // => true

// In tests, SecureRandom.make takes any byte source, so ids become deterministic.
const zeros = Layer.succeed(SecureRandom.SecureRandom, SecureRandom.make((size) => new Uint8Array(size)))
const fixed = await Effect.runPromise(newId.pipe(Effect.provide(zeros)))
fixed // => "00000000-0000-4000-8000-000000000000"
```

`SecureRandom` also has `randomBytes(n)`, `intBetween(min, max)`, `shuffle(items)`,
`uuidV7()` and `ulid`. All are infallible `Effect`s. For a secret token,
`Hex.encode(yield* random.randomBytes(32))`.

## HMAC with `Mac`

`Mac.key(algorithm, bytes)` builds a key (an empty key fails with `CryptoError`).
`Mac.Key` values print as `{"_id":"Mac.Key"}`, so a key in a log line leaks nothing.
`verify` compares in constant time and returns `false` for any wrong or
wrong-length tag.

```ts import.meta.vitest name="references/encoding/crypto-and-patch.md#2"
import { Effect, Layer } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"

const live = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
const bytes = (text: string) => new TextEncoder().encode(text)

const program = Effect.gen(function*() {
  const mac = yield* Mac.Mac
  const key = yield* Mac.key(Mac.hmacSha256, bytes("secret"))
  const tag = yield* mac.sign(key, bytes("hello"))
  return {
    tag: Hex.encode(tag),
    good: yield* mac.verify(key, tag, bytes("hello")),
    tampered: yield* mac.verify(key, tag, bytes("hellp"))
  }
})

const result = await Effect.runPromise(program.pipe(Effect.provide(live)))
result // => { tag: "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b", good: true, tampered: false }
```

The full session-token recipe in [guide.md](guide.md) builds on this.

## JSON patches

```ts import.meta.vitest name="references/encoding/crypto-and-patch.md#3"
import { Effect, JsonPatch } from "effect"

const before = { name: "a", tags: ["x"] }
const after = { name: "b", tags: ["x", "y"] }

// Compute a patch between two documents...
const patch = JsonPatch.get(before, after)
patch // => [{ op: "replace", path: "/name", value: "b" }, { op: "add", path: "/tags/1", value: "y" }]

// Then apply it. apply THROWS if a path does not exist, so wrap it.
const applyPatch = (doc: typeof before) =>
  Effect.try({
    try: () => JsonPatch.apply(patch, doc),
    catch: (cause) => new Error(String(cause))
  })

const patched = await Effect.runPromise(applyPatch(before))
patched // => { name: "b", tags: ["x", "y"] }

const failed = await Effect.runPromise(Effect.flip(applyPatch({ name: "a", tags: [] as Array<string> })))
failed instanceof Error // => true
```

Only `add`, `remove` and `replace` exist, and values are `Schema.Json`. Treat an
inbound patch from a client as untrusted input: decode it with a Schema, allow-list
the paths, and apply it to a document you re-validate afterwards.
