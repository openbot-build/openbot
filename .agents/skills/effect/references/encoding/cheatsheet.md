# Encoding cheat sheet (effect@4.1.2)

Signatures checked against `node_modules/effect/src/**/*.ts` (4.1.2).

## Raw codecs (`import { Base64, Base64Url, Hex } from "effect/encoding"`)

All three modules have the same shape:

```
encode(input: Uint8Array | string): string
decode(str: string): Result<Uint8Array, EncodingError>
decodeString(str: string): Result<string, EncodingError>   // UTF-8 text
```

`Base64Url.encodePadded(input)` is the same alphabet with `=` padding.

`Hex.random(length: number): string` also exists: **not cryptographically
secure** (`Math.random`), and `length` counts hex characters, rounded down to a
multiple of 8. For secrets use `SecureRandom#randomBytes` + `Hex.encode`.

`EncodingError` is a tagged error (`_tag: "EncodingError"`) with fields
`kind: "Decode" | "Encode"`, `module: string`, `input: unknown`, `message`.
Narrow with `isEncodingError`. Turn a `Result` into an Effect with
`Effect.fromResult(result)`; a `Result` is not itself yieldable in `Effect.gen`.

Behaviours: `Base64.decode` requires padding (length multiple of 4);
`Base64Url.decode` accepts unpadded input (and, in 4.1, correctly padded input) but
rejects `+` and `/`; `Hex.decode("zz")` fails with `"Invalid input"`.

## Schema codecs (all from `Schema`)

`StringFromBase64`, `StringFromBase64Url`, `StringFromHex`,
`StringFromUriComponent`; `Uint8ArrayFromBase64`, `Uint8ArrayFromBase64Url`,
`Uint8ArrayFromHex`; `Uint8Array` (instance check); `Json`, `MutableJson`,
`JsonObject`; `UnknownFromJsonString`; `fromJsonString(S, { space? })`.

Chain with `Schema.decodeTo`: `Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(S)))`
decodes `base64url text -> JSON text -> S` and encodes in reverse.

## Config text parsers

| | Signature | On bad input |
| --- | --- | --- |
| `Yaml.parse` | `(input: string) => unknown` | throws `SyntaxError` |
| `Toml.parse` | `(input: string) => Result<Record<string, unknown>, EncodingError>` (null-prototype record) | `Result.fail` (it threw in 4.0.0) |
| `Json5.parse` | `(input: string) => Result<unknown, EncodingError>` | `Result.fail` |
| `Jsonc.parse` | `(input: string) => Result<unknown, EncodingError>` | `Result.fail` |
| `Ini.parse` | `(input: string) => Record<string, unknown>` (values are strings) | lenient: the source contains no `throw`; treat output as untrusted |

YAML limits (from the module docs): no multi-document streams, no tag/directive
processing, no explicit complex keys, no multiline flow collections. 4.1 adds merge
keys (`<<`) and rejects duplicate keys.
Offset date-times in TOML become `Date`; local dates and times stay strings.

## Ndjson (channels for `Stream.pipeThroughChannel`)

| Function | Input chunk | Output | Error |
| --- | --- | --- | --- |
| `Ndjson.decodeString(opts?)` | `string` | `unknown` | `NdjsonError` |
| `Ndjson.decode(opts?)` | `Uint8Array` | `unknown` | `NdjsonError` |
| `Ndjson.decodeSchemaString(S)(opts?)` | `string` | `S["Type"]` | `NdjsonError \| SchemaError` |
| `Ndjson.decodeSchema(S)(opts?)` | `Uint8Array` | `S["Type"]` | same |
| `Ndjson.encodeString()` / `encode()` | `unknown` | `string` / `Uint8Array` | `NdjsonError` |
| `Ndjson.encodeSchemaString(S)()` / `encodeSchema(S)()` | `S["Type"]` | `string` / `Uint8Array` | `NdjsonError \| SchemaError` |
| `duplex*` | wrap a duplex byte/string channel (e.g. a socket) | | |

`opts = { ignoreEmptyLines?: boolean }`. `NdjsonError` has `kind: "Pack" | "Unpack"`,
`cause`, and (4.1) an optional `reason`: `"InvalidJson" | "InvalidUtf8" | "LineTooLarge"`. Note the schema variants are *curried twice*: `decodeSchemaString(S)()`.
The schema's `DecodingServices` / `EncodingServices` appear in the stream's `R`.

## Sse

| Function | Notes |
| --- | --- |
| `Sse.decode(opts?)` | `string -> Sse.Event` (`_tag: "Event"`, `id`, `event` (default `"message"`), `data`). `id` persists across events per the SSE spec |
| `Sse.decodeDataSchema(S, opts?)` | JSON-decodes `data` with `S` (it adds `fromJsonString` itself) -> `{ event, id, data }` |
| `Sse.decodeSchema(codec, opts?)` | codec over `{ id?, event?, data }` |
| `Sse.encode()` / `Sse.encodeSchema(codec)` | produces `string` frames |
| `Sse.makeParser(onParse, opts?)` | low-level incremental parser |

`opts = { maxEventSize?: number, dispatchEmptyNamedEvents?: boolean }` (4.1), default 10 MiB; exceeding it fails with
`SseError` whose `reason` is `EventTooLarge`. A server `retry:` field is emitted
as a **failure** `Sse.Retry` (`_tag: "Retry"`, `duration`, `lastEventId`).

## Other 4.1 channels (details in [formats.md](formats.md))

| Module | Channels | Error |
| --- | --- | --- |
| `Csv` | `decodeString` / `decode` / `decodeSchemaString(S)` / `decodeSchema(S)`; `encodeString` / `encode` / `encodeSchemaString(S)` / `encodeSchema(S)` | `CsvError` (`kind: "Syntax" \| "RecordSize" \| "Header"`) |
| `JsonArray` | same eight names; `{ pointer?, maxDepth?, maxElementSize? }` | `JsonArrayError` |
| `Xml` | `decodeString` / `decode` (events), `elements(path)`, `encodeString` / `encode` | `XmlError` |
| `Tar`, `Zip` | `decode()` / `encode()` with `file`, `fileStream`, `directory` entry builders (`Tar` also `symlink`, `hardlink`) | `TarError`, `ZipError` |

`Bytes` (from `"effect"`): `concat`, `Equivalence`, `Order` for `Uint8Array`.

## SchemaBinary

`SchemaBinary.encode(S, opts?)()` and `decode(S, opts?)()` are channels over
`Uint8Array` frames; `toCodec(S)` gives a `Schema.Codec<S["Type"], Uint8Array>`;
`parser(S, opts)` (`feed`, `feedSync`, `end`) and `encoder(S, opts)` are the
incremental primitives (`toCodecStrict(S)` is the strict variant). Options: `fingerprint`, `maxFrameSize`, `dictionary`
(encoder/parser). `fieldId(n)` pins a field's numeric id for evolution.

## Crypto (`import { Digest, Mac, SecureRandom, ... } from "effect/crypto"`)

The 4.0 `Crypto` service is gone. Each concern is a `Context.Service` with a
`layerWebCrypto`; `NodeCrypto.layer*` from `@effect/platform-node` are native-backed
equivalents. Most are marked unstable in the source.

| Service | Members |
| --- | --- |
| `Digest.Digest` | `digest(algo, bytes): Effect<Uint8Array>`, `digestHex(algo, bytes): Effect<string>`; algos `Digest.md5 \| sha1 \| sha256 \| sha384 \| sha512` |
| `SecureRandom.SecureRandom` | `randomBytes(n)`, `intBetween(min, max, { halfOpen? })`, `shuffle(items)`, `uuidV4()`, `uuidV7()` (`{ format: "bytes" }` for bytes), `ulid`; all infallible. `SecureRandom.make(bytesFn)` for tests |
| `Mac.Mac` | `generateKey(algo)`, `sign(key, data)`, `verify(key, tag, data): Effect<boolean>`, errors `CryptoError`; `Mac.key(algo, bytes)`, `Mac.hmacSha256 \| 1 \| 384 \| 512`, `Mac.timingSafeEqual` |
| `Kdf.Kdf` | HKDF, PBKDF2 (`Kdf.pbkdf2Sha256`), `Kdf.argon2id(...)` (Node layer only) |
| `Aead.Aead` | AES-GCM (`aes256Gcm`), `chacha20Poly1305`, `xchacha20Poly1305`; `Aead.key(algo, bytes)` |
| `Signature.Signature`, `KeyAgreement`, `KeyWrap`, `Cipher` | Ed25519 / ECDSA / RSA-PSS; X25519 / ECDH; AES-KW / RSA-OAEP; AES-CTR / CBC |

Layers: `Digest.layerWebCrypto`, `SecureRandom.layerWebCrypto`,
`Mac.layerWebCrypto` (needs `SecureRandom`), `Kdf.layerWebCrypto`,
`Aead.layerWebCrypto` (needs `SecureRandom`). `WebCrypto.layer(crypto)` swaps the
underlying `Crypto` object (polyfill, test double). Errors are `CryptoError`
(`reason` is `InvalidArgument | InvalidKey | DecryptionFailed | Unsupported | NotExtractable`).
Keys print as `{"_id":"Mac.Key",...}` and never expose their bytes.

## JsonPatch / JsonPointer

```
JsonPatch.get(oldValue: Schema.Json, newValue: Schema.Json): JsonPatch
JsonPatch.apply(patch: JsonPatch, oldValue: Schema.Json): Schema.Json   // throws on a missing path
type JsonPatchOperation = { op: "add"|"replace", path, value } | { op: "remove", path }  // + optional description
JsonPointer.escapeToken / unescapeToken / parseUriFragment / formatUriFragment
```

## v3 to v4 (and 4.0 to 4.1)

4.0 to 4.1: `Crypto.Crypto` became `effect/crypto` (see above); `Toml.parse` returns a
`Result`; `Csv`, `JsonArray`, `Json5`, `Jsonc`, `Xml`, `Tar`, `Zip`, `Bytes` are new.

v4 groups the byte codecs under `effect/encoding` (`Base64`, `Base64Url`, `Hex`),
returning `Result<_, EncodingError>`; `Effect.fromResult` replaces
`Effect.fromEither`. `Ndjson`, `Sse` and `SchemaBinary` live in core
(`effect/encoding`) as Channels. The `effect/unstable/...` paths no longer exist.
