# Encoding, formats and cryptographic boundaries

## How to think about it

Every wire format is a **partial function**: most strings are not valid
Base64, most bytes are not UTF-8, most text is not YAML. A decoder that
cannot fail is lying to you (`Buffer.from(x, "base64")` happily returns
garbage for `"!!!"`). So in Effect a decoder is a value that can fail with a
typed error, and you choose *where in your program* that failure becomes a
domain concept (`InvalidToken`, `BadConfig`) rather than a stack trace.

There are **three layers**, and picking the right one is most of the skill:

1. **Raw codecs** (`Base64`, `Base64Url`, `Hex`): synchronous functions
   `string -> Result<Uint8Array | string, EncodingError>`. Use for ad hoc work
   or inside a service implementation.
2. **Schema codecs** (`Schema.StringFromBase64Url`, `Schema.Uint8ArrayFromHex`,
   `Schema.fromJsonString(S)`, ...): the same conversions *as schemas*, so they
   compose into a struct field or a whole request model and fail with a
   `SchemaError` that says which field was wrong. Prefer these inside domain
   models: a "token" field *is* a `Base64Url`-encoded JSON object, say so in the
   type.
3. **Streaming channels** (`Ndjson`, `Sse`, `SchemaBinary`, and in 4.1 `Csv`,
   `JsonArray`, `Xml`, `Tar`, `Zip`): incremental decoders/encoders you plug into
   a `Stream` with `Stream.pipeThroughChannel`. Use when records arrive in chunks
   that do not align with record boundaries. The 4.1 ones are in
   [formats.md](formats.md).

Two more facts people get wrong: **encoding is not security** (Base64 hides
nothing) and **config-text parsers disagree about failure**: `Yaml.parse` returns a plain
`unknown` and signals bad input by throwing `SyntaxError`; `Toml.parse`,
`Json5.parse` and `Jsonc.parse` (all 4.1) return a `Result` like the byte codecs;
`Ini.parse` is lenient (no throw, string values). Wrap the throwing one in
`Effect.try`, turn the `Result`s into Effects with `Effect.fromResult`, then
decode the value with a `Schema`; never trust the parsed shape.

## Choose

| Situation | Use | Why |
| --- | --- | --- |
| A field in your model is Base64/Hex text of bytes | `Schema.Uint8ArrayFromBase64Url` / `...FromBase64` / `...FromHex` | the codec lives in the type; errors point at the field |
| A field is text that must be Base64/Hex-encoded | `Schema.StringFromBase64Url` / `StringFromBase64` / `StringFromHex` | same |
| A string holds JSON of a known shape | `Schema.fromJsonString(Shape)` | parse + validate in one step |
| A string holds JSON, shape unknown yet | `Schema.UnknownFromJsonString` | then refine with another schema |
| Quick one-off encode in an implementation | `Base64Url.encode(bytesOrString)` | sync, total |
| Quick one-off decode | `Base64Url.decode(s)` / `decodeString(s)` then `Effect.fromResult` | `Result<_, EncodingError>`, never throws |
| JWT-like/URL-safe tokens, URL params | `Base64Url` (no padding, `-` `_`) | standard Base64 breaks in URLs |
| MIME, data URIs, existing Base64 APIs | `Base64` (padded, `+` `/`) | what the protocol says |
| YAML config text | `Yaml.parse` inside `Effect.try`, then `Schema` | Yaml throws `SyntaxError`; output is untrusted |
| TOML / JSONC / JSON5 config text | `Effect.fromResult(Toml.parse(text))` (or `Jsonc.parse`, `Json5.parse`), then `Schema` | return `Result`, never throw; see [formats.md](formats.md) |
| INI config text | `Ini.parse`, then `Schema` | lenient, never throws, string values only |
| CSV files or uploads | `Csv.decodeSchemaString(S)({ headers: true })` | quoted newlines, chunk splits and typed columns handled |
| Huge JSON array / array inside an envelope | `JsonArray.decodeSchemaString(S)({ pointer })` | one element at a time, bounded memory |
| XML feed / tar / zip | `Xml.decodeString()` + `Xml.elements(path)`; `Tar` / `Zip` | streaming, with size and depth limits |
| Line-delimited JSON over a stream | `Ndjson.decodeSchemaString(S)()` | splits across chunk boundaries, validates |
| Server-Sent Events client | `Sse.decodeDataSchema(S)` | splits events, JSON-decodes `data` |
| Server-Sent Events server | `Sse.encode()` / `Sse.encodeSchema(codec)` | correct framing |
| Length-framed, schema-versioned binary | `SchemaBinary.decode(S)()` / `encode` | self-describing frames, `maxFrameSize` |
| SHA hash | `Digest.Digest` from `effect/crypto` | swappable, runs on Web Crypto |
| Secure random bytes, UUID v4/v7, ULID | `SecureRandom.SecureRandom` | deterministic in tests via `SecureRandom.make` |
| HMAC | `Mac.Mac` (`Mac.key`, `sign`, `verify`) | constant-time verify, key never prints |
| Signatures, encryption, key derivation | `Signature`, `Aead`, `Kdf` in `effect/crypto` | see [crypto-and-patch.md](crypto-and-patch.md) |
| Compute / apply a JSON diff | `JsonPatch.get(old, new)` / `JsonPatch.apply(patch, doc)` | only add/remove/replace |
| Config values from env | [config](../config/guide.md), not this skill | `Config` already decodes env |
| Request/response bodies over HTTP | [http](../http/guide.md) / [http-api](../http-api/guide.md) | they already decode with Schema |
| Pure value randomness (not secret) | `Random` (see [time](../time/guide.md)) | testable seed |

## Recipe

A realistic boundary: issue and verify signed, expiring session tokens
(`<base64url(json)>.<base64url(hmac)>`). It shows all three layers working
together, plus the secrets and error design.

First the pitfall.

```ts skip
// PITFALL: nothing here can be tested, nothing here is typed.
import { createHmac } from "node:crypto"
export function verify(token: string): { sub: string } | null {
  const [body, sig] = token.split(".")             // may be undefined
  const expected = createHmac("sha256", process.env.KEY!) // global secret, throws if unset
    .update(body!).digest("base64url")
  if (sig !== expected) return null                // not constant-time; null hides WHY
  return JSON.parse(Buffer.from(body!, "base64url").toString()) // throws; unvalidated cast
}
```

Now the Effect version.

```ts import.meta.vitest name="references/encoding/guide.md#2"
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import { Mac, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"

// 1. The wire format is a TYPE. Decoding "base64url text -> JSON text -> Claims"
//    is one schema; encoding is the exact inverse, for free.
export const Claims = Schema.Struct({
  sub: Schema.String,
  exp: Schema.Number // epoch millis
})
export type Claims = typeof Claims.Type
const ClaimsFromBody = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Claims))
)

// 2. Expected failures are separate tags: callers branch on them
//    (401 for Malformed/BadSignature, "please log in again" for Expired).
export class Malformed extends Schema.TaggedError<Malformed>()("Malformed", {
  reason: Schema.String
}) {}
export class BadSignature extends Schema.TaggedError<BadSignature>()("BadSignature", {}) {}
export class Expired extends Schema.TaggedError<Expired>()("Expired", {
  at: Schema.Number
}) {}

const bytes = (text: string) => new TextEncoder().encode(text)

export class Tokens extends Context.Service<Tokens, {
  issue(claims: Claims): Effect.Effect<string>
  verify(token: string): Effect.Effect<Claims, Malformed | BadSignature | Expired>
}>()("app/Tokens") {
  // 3. HMAC is a capability: the layer needs `Mac.Mac`, so domain code never
  //    touches node:crypto and tests can swap the implementation. The secret
  //    arrives Redacted, so logging the layer's config never prints it.
  static readonly layer = (secret: Redacted.Redacted<string>) =>
    Layer.effect(
      Tokens,
      Effect.gen(function*() {
        const mac = yield* Mac.Mac
        // A key that cannot be built (empty secret) means the app is misconfigured: die.
        const key = yield* Mac.key(Mac.hmacSha256, bytes(Redacted.value(secret))).pipe(Effect.orDie)

        const issue = Effect.fn("Tokens.issue")(function*(claims: Claims) {
          // Encoding a value we built ourselves cannot be invalid: if it fails
          // that is a bug, so it is a defect (orDie), not part of E.
          const body = yield* Schema.encodeEffect(ClaimsFromBody)(claims).pipe(Effect.orDie)
          const tag = yield* mac.sign(key, bytes(body)).pipe(Effect.orDie)
          return `${body}.${Base64Url.encode(tag)}`
        })

        const verify = Effect.fn("Tokens.verify")(function*(token: string) {
          const parts = token.split(".")
          const [body, signature] = parts
          if (parts.length !== 2 || body === undefined || signature === undefined) {
            return yield* new Malformed({ reason: "expected two parts" })
          }
          // The raw codec gives a typed error for non-Base64 input.
          const tag = yield* Effect.fromResult(Base64Url.decode(signature)).pipe(
            Effect.mapError((e) => new Malformed({ reason: e.message }))
          )
          // Check the signature BEFORE parsing the body: never decode what you
          // have not authenticated. `verify` compares in constant time.
          const authentic = yield* mac.verify(key, tag, bytes(body)).pipe(Effect.orDie)
          if (!authentic) {
            return yield* new BadSignature()
          }
          const claims = yield* Schema.decodeUnknownEffect(ClaimsFromBody)(body).pipe(
            Effect.mapError((e) => new Malformed({ reason: e.message }))
          )
          const now = yield* Clock.currentTimeMillis // not Date.now(): TestClock can drive it
          if (claims.exp <= now) {
            return yield* new Expired({ at: claims.exp })
          }
          return claims
        })

        return Tokens.of({ issue, verify })
      })
    )
}

// Composition root: the secret is read once, from Config, in the real main.
// Mac.layerWebCrypto needs SecureRandom (for generateKey); both run on Web Crypto.
const CryptoLive = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
export const TokensLive = Tokens.layer(Redacted.make("dev-only-secret")).pipe(Layer.provide(CryptoLive))

const run = <A, E>(effect: Effect.Effect<A, E, Tokens>) => Effect.runPromise(Effect.provide(effect, TokensLive))

const token = await run(Tokens.use((tokens) => tokens.issue({ sub: "ada", exp: 4_102_444_800_000 })))

const claims = await run(Tokens.use((tokens) => tokens.verify(token)))
claims // => { sub: "ada", exp: 4102444800000 }

// Flip a character of the body: the signature no longer matches.
const forged = `${token[0] === "e" ? "f" : "e"}${token.slice(1)}`
const forgedError = await run(Tokens.use((tokens) => tokens.verify(forged)).pipe(Effect.flip))
forgedError._tag // => "BadSignature"

const old = await run(Tokens.use((tokens) => tokens.issue({ sub: "ada", exp: 1 })))
const expired = await run(Tokens.use((tokens) => tokens.verify(old)).pipe(Effect.flip))
expired._tag // => "Expired"

const junk = await run(Tokens.use((tokens) => tokens.verify("not-a-token")).pipe(Effect.flip))
junk._tag // => "Malformed"
```

Design decisions worth copying:

- Encoding and decoding share one definition (`ClaimsFromBody`), so they cannot
  drift. Raw `Base64Url` is used only where bytes are compared.
- Errors are split by what the caller does next. Parse failures from untrusted
  input are `Malformed`; failures to encode our own value are defects.
- The signing key is `Redacted`, injected through a Layer, never `process.env`.
- Authenticate first, parse second, check expiry last. `Mac.verify` is constant
  time and returns `false` for a wrong-length tag, so there is no `===` to get wrong.
- Crypto is a service from `effect/crypto` (`Mac`, `Digest`, `SecureRandom`, ...).
  For unique IDs use `SecureRandom` ([crypto-and-patch.md](crypto-and-patch.md))
  rather than `Math.random`.

### Config text: parse, then decode (typed)

```ts import.meta.vitest name="references/encoding/guide.md#3"
import { Effect, Schema } from "effect"
import { Toml, Yaml } from "effect/encoding"

export class BadConfig extends Schema.TaggedError<BadConfig>()("BadConfig", {
  format: Schema.Literals(["yaml", "toml"]),
  message: Schema.String
}) {}

const Settings = Schema.Struct({
  port: Schema.Int,
  hosts: Schema.Array(Schema.String)
})

// Yaml.parse THROWS SyntaxError: Effect.try makes it a typed failure.
// Toml.parse returns a Result: Effect.fromResult does the same job.
// Either way the value is untrusted, and the Schema checks its SHAPE. Both steps are needed.
const parseText = (format: "yaml" | "toml", text: string) =>
  format === "yaml"
    ? Effect.try({ try: () => Yaml.parse(text), catch: (cause) => String(cause) })
    : Effect.fromResult(Toml.parse(text)).pipe(Effect.mapError((error) => error.message))

export const parseSettings = (format: "yaml" | "toml", text: string) =>
  parseText(format, text).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(Settings)(value).pipe(Effect.mapError((error) => error.message))
    ),
    Effect.mapError((message) => new BadConfig({ format, message }))
  )

const fromYaml = await Effect.runPromise(parseSettings("yaml", "port: 8080\nhosts: [a, b]"))
fromYaml // => { port: 8080, hosts: ["a", "b"] }

const fromToml = await Effect.runPromise(parseSettings("toml", "port = 9090\nhosts = [\"c\"]"))
fromToml // => { port: 9090, hosts: ["c"] }

// Syntactically fine, wrong shape: the Schema step rejects it with the same tag.
const wrongShape = await Effect.runPromise(Effect.flip(parseSettings("yaml", "port: nope")))
wrongShape._tag // => "BadConfig"
```

For JSONC or JSON5 (comments, trailing commas) use `Effect.fromResult(Jsonc.parse(text))`
exactly as for TOML ([formats.md](formats.md)).

### Streaming: NDJSON and SSE through a Stream

```ts import.meta.vitest name="references/encoding/guide.md#4"
import { Effect, Schema, Stream } from "effect"
import { Ndjson, Sse } from "effect/encoding"

class LogLine extends Schema.Class<LogLine>("LogLine")({
  level: Schema.Literals(["info", "error"]),
  message: Schema.String
}) {}

// Chunks split mid-record, as network and file reads do. The channel buffers
// partial lines, so you never write a manual "leftover" accumulator.
const chunks = Stream.make("{\"level\":\"info\",\"mess", "age\":\"a\"}\n{\"level\":\"error\",", "\"message\":\"b\"}\n")

const logs = chunks.pipe(
  // ignoreEmptyLines: tolerate a trailing blank line instead of a parse error.
  Stream.pipeThroughChannel(Ndjson.decodeSchemaString(LogLine)({ ignoreEmptyLines: true })),
  // Error channel is NdjsonError | SchemaError: both tagged, both catchable.
  Stream.catchTag("NdjsonError", (e) => Stream.die(`bad line (${e.kind})`)),
  Stream.map((line) => `${line.level}: ${line.message}`),
  Stream.runCollect
)

// SSE: events arrive as text chunks. decodeDataSchema wraps your schema in
// fromJsonString for you, so pass the plain Struct (not fromJsonString(...)).
const Tick = Schema.Struct({ n: Schema.Number })
const ticks = Stream.make("event: tick\ndata: {\"n\":1}\n\n", "data: {\"n\":2}\n\n").pipe(
  Stream.pipeThroughChannel(Sse.decodeDataSchema(Tick)),
  Stream.map((event) => event.data.n),
  Stream.runCollect
)
// A `retry:` line from the server surfaces as a `Sse.Retry` FAILURE carrying a
// Duration: catch it with Stream.catchTag("Retry", ...) and reconnect after it.

const lines = await Effect.runPromise(logs)
lines // => ["info: a", "error: b"]

const numbers = await Effect.runPromise(ticks)
numbers // => [1, 2]
```

### Hashes, random IDs and JSON patches

`Digest`, `SecureRandom`, `Mac` (and `Kdf`, `Aead`, `Signature`) from `effect/crypto`, and
`JsonPatch.get`/`apply` (which throws on a missing path, so wrap it in `Effect.try`)
have runnable examples in [crypto-and-patch.md](crypto-and-patch.md).

## Anti-patterns

**1. Trusting a lenient decoder.** `Buffer.from(s, "base64")` never fails and
`atob` throws a DOMException; both turn bad input into garbage or a crash.

```ts skip
const bytes = Buffer.from(userInput, "base64url") // "!!!" -> empty buffer, no error
```
```ts import.meta.vitest name="references/encoding/guide.md#6"
import { Effect } from "effect"
import { Base64Url } from "effect/encoding"

const decode = (input: string) => Effect.fromResult(Base64Url.decode(input))

const bytes = await Effect.runPromise(decode("aGVsbG8"))
bytes // => new TextEncoder().encode("hello")

const error = await Effect.runPromise(Effect.flip(decode("!!!")))
error._tag // => "EncodingError"
```

**2. Mixing Base64 and Base64Url.** `Base64Url.decode("aGVsbG8/Pg==")` fails (`/` is not in
its alphabet; in 4.1 correctly padded input is accepted, `+` and `/` never are) and
`Base64.decode` rejects unpadded input. `Base64Url.encodePadded` (4.1) emits `=` padding
when a protocol insists. Take the
alphabet from the protocol (JWT, URL params: Base64Url) and keep one choice per field.

**3. Parsing config without a Schema.** `Yaml.parse` returns `unknown`; casting it
(`as Settings`) moves the crash to a random later line. Always
`Schema.decodeUnknownEffect` the parsed value.

**4. Forgetting that `Yaml.parse` throws.** Calling `Yaml.parse(text)` inside `Effect.gen`
directly makes the thrown `SyntaxError` a *defect* (an untyped crash). Use
`Effect.try` with a `catch` that builds your tagged error. (`Toml.parse`, `Json5.parse` and
`Jsonc.parse` return a `Result` instead: `yield* Effect.fromResult(...)`.)

**5. Comparing signatures with `===`.** String equality leaks timing. Use
`Mac.verify` (constant time), or `Mac.timingSafeEqual(a, b)` for bytes you computed
yourself.

**6. Decoding before authenticating.** Parsing attacker-controlled JSON, YAML or
a patch first exposes the parser (and its size/shape risks) to anyone.
Verify the signature or enforce a size limit (`Sse` `maxEventSize`,
`SchemaBinary` `maxFrameSize`, `Stream.limitBytes`) first.

**7. Using `Hex.random` for secrets.** It uses `Math.random()` and its `length`
counts hex characters (rounded down to a multiple of 8). For tokens and keys:

```ts import.meta.vitest name="references/encoding/guide.md#7"
import { Effect } from "effect"
import { SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"

const secretToken = Effect.gen(function*() {
  const random = yield* SecureRandom.SecureRandom
  return Hex.encode(yield* random.randomBytes(32))
})

const token = await Effect.runPromise(secretToken.pipe(Effect.provide(SecureRandom.layerWebCrypto)))
token.length // => 64
```

**8. Collecting a stream to parse it.** `Stream.mkString` / `runCollect` then
`JSON.parse(lines.split("\n"))` holds the whole payload. Use the NDJSON channel and
process records as they arrive.

**9. Assuming `Result` is `yield*`-able.** In `Effect.gen` you must convert with
`Effect.fromResult(result)`; yielding a `Result` fails at runtime ("Not a valid effect").

## Testing it

Raw codecs and Schema codecs are pure: test them with plain assertions, no runtime
needed. Test the round trip and the failure modes.

```ts import.meta.vitest name="references/encoding/guide.md#8"
import assert from "node:assert/strict"
import { Effect, Exit, Schema } from "effect"
import { Base64Url, Hex, Ndjson } from "effect/encoding"
import { Stream } from "effect"

// Round trip and the typed failure.
const encoded = Base64Url.encode("hello?>")
assert.equal(encoded, "aGVsbG8_Pg")
assert.equal(Base64Url.decodeString(encoded)._tag, "Success")
assert.equal(Base64Url.decode("!!!")._tag, "Failure")
assert.equal(Hex.encode("hi"), "6869")

// Schema codec: a field that is base64url text of JSON.
const Payload = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Struct({ n: Schema.Number })))
)
assert.deepEqual(Schema.decodeUnknownSync(Payload)(Schema.encodeSync(Payload)({ n: 1 })), { n: 1 })
assert.ok(Exit.isFailure(Schema.decodeUnknownExit(Payload)("!!!")))

// Streaming decoders are testable with in-memory chunks, split anywhere.
const decoded = await Effect.runPromise(
  Stream.make("{\"a\"", ":1}\n{\"a\":2}", "\n").pipe(
    Stream.pipeThroughChannel(Ndjson.decodeString()),
    Stream.runCollect
  )
)
assert.deepEqual(decoded, [{ a: 1 }, { a: 2 }])
```

For services such as `Tokens`, the real `Mac.layerWebCrypto` is already
deterministic (HMAC is a pure function of key and data), so tests need no fake.
Fake the clock with `TestClock` from `effect/testing` to test `Expired` without
waiting. `@effect/vitest`'s `it.effect` installs the `TestClock` automatically (the
same `Tokens` layer, built over `Mac.layerWebCrypto`, goes in `Effect.provide`):

```ts
import { assert, it } from "@effect/vitest"
import { Clock, Data, Effect } from "effect"
import { TestClock } from "effect/testing"

class Expired extends Data.TaggedError("Expired")<{ readonly at: number }> {}

// The same clock check the Tokens recipe does, in isolation.
const checkExpiry = (exp: number) =>
  Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    if (exp <= now) return yield* new Expired({ at: exp })
    return exp
  })

it.effect("expires once the test clock passes exp", () =>
  Effect.gen(function*() {
    assert.strictEqual(yield* checkExpiry(1_000), 1_000)
    yield* TestClock.adjust(2_000)
    const error = yield* Effect.flip(checkExpiry(1_000))
    assert.strictEqual(error._tag, "Expired")
  }))
```

For random IDs, `SecureRandom.make((size) => bytes)` builds a deterministic
implementation; wrap it with `Layer.succeed(SecureRandom.SecureRandom, impl)`.

## Changed in 4.1

- `Crypto` (one service: digest, random bytes, UUIDs) is gone. `effect/crypto` has one
  service per concern: `Digest`, `SecureRandom`, `Mac` (HMAC, new), `Kdf`, `Aead`,
  `Cipher`, `Signature`, `KeyAgreement`, `KeyWrap`. The token recipe no longer needs a
  hand-rolled `node:crypto` signer.
- `NodeServices.layer` no longer provides crypto; add `NodeCrypto.layer` or the
  `effect/crypto` web layers.
- New codecs in `effect/encoding`: `Csv`, `JsonArray`, `Json5`, `Jsonc`, `Xml`, `Tar`,
  `Zip` ([formats.md](formats.md)). `Json5.parse` and `Jsonc.parse` return `Result`.
- `Base64Url.decode` accepts correctly padded input and `Base64Url.encodePadded` exists.
- `Sse.decode` takes `dispatchEmptyNamedEvents`; `Ndjson` errors carry a `reason`
  (`"InvalidJson" | "InvalidUtf8" | "LineTooLarge"`); `SchemaBinary.toCodecStrict` exists.
- **Breaking:** `Toml.parse` now returns `Result<Record<string, unknown>, EncodingError>`
  instead of throwing. Code written for 4.0 that wraps it in `Effect.try` now sees a
  `Result` object and must use `Effect.fromResult`.
- `Yaml.parse` (still throws) supports merge keys (`<<`) and rejects duplicate keys;
  `Toml.parse` validates dates and rejects more redefinitions.
- New `Bytes` module (`concat`, `Equivalence`, `Order`) in `effect`.

## Boundaries

- [schema](../schema/guide.md) owns the codec algebra (`decodeTo`, `fromJsonString`, `Class`,
  `SchemaError`). This skill owns the byte/text formats and the streaming channels.
- [streams](../streams/guide.md): `pipeThroughChannel`, `decodeText`, `splitLines`, backpressure,
  `catchTag` on stream errors.
- [platform](../platform/guide.md): where the file system that supplies bytes comes from
  (`NodeServices.layer`). Crypto is separate: the `effect/crypto` layers or `NodeCrypto.layer`.
- [config](../config/guide.md): secrets from the environment (`Config.redacted`), loaded once
  into a Layer; this skill only consumes a `Redacted`.
- [http](../http/guide.md) / [http-api](../http-api/guide.md): HTTP bodies and headers are decoded with the
  same Schema codecs; SSE responses are produced there from a `Sse.encode` channel.
- [core](../core/guide.md): `Effect.try`, `orDie`, and when a failure is a defect.
- Errors that cross out: `EncodingError`, `NdjsonError`, `SseError`,
  `SchemaError` -> convert to your domain tags at the service boundary.

## References

- [Cheat sheet with signatures and gotchas](cheatsheet.md)
- [Crypto and JSON patch recipes](crypto-and-patch.md)
- [CSV, JSON array, JSON5/JSONC, XML, tar, zip](formats.md)
- [Base64Url API](https://effect.website/docs/v4/api/effect/encoding/Base64Url)
- [Ndjson API](https://effect.website/docs/v4/api/effect/encoding/Ndjson)
- [Sse API](https://effect.website/docs/v4/api/effect/encoding/Sse)
- [crypto API](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/effect/src/crypto)
- [JsonPatch API](https://effect.website/docs/v4/api/effect/JsonPatch)
- [Pinned encoding sources](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/effect/src/encoding)
- [Pinned Base64Url source](https://github.com/Effect-TS/effect/blob/effect%404.1.2/packages/effect/src/encoding/Base64Url.ts)
- [Pinned crypto sources](https://github.com/Effect-TS/effect/tree/effect%404.1.2/packages/effect/src/crypto)
- [Upstream stream encoding example](https://github.com/Effect-TS/effect/blob/effect%404.1.2/ai-docs/src/03_stream/30_encoding.ts)
