# Data formats added in 4.1: CSV, JSON arrays, JSON5/JSONC, XML, tar, zip

Everything here is imported from `"effect/encoding"`. The streaming ones are
`Channel`s you plug into a `Stream` with `Stream.pipeThroughChannel`; they accept
chunks split at any byte and keep partial records for you. All are marked
unstable or experimental in the source, so pin your version.

## CSV (`Csv`)

Use the schema variants for typed rows: by default the schema is wrapped in a
string-tree codec, so `Schema.Number`, `Schema.Boolean`, `Schema.Date` columns
decode from cell text. Empty cells of optional fields decode as a missing key.
Errors are `CsvError` (`kind: "Syntax" | "RecordSize" | "Header"`) or `SchemaError`.

```ts import.meta.vitest name="references/encoding/formats.md#1"
import { Effect, Schema, Stream } from "effect"
import { Csv } from "effect/encoding"

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
  nickname: Schema.optionalKey(Schema.String)
})

// Chunks split mid-cell; the quoted comma and newline survive.
const input = Stream.make("name,age,nickname\nAlice,32,Al\n\"Smith, B", "ob\",41,\n")

const people = await Effect.runPromise(
  input.pipe(
    Stream.pipeThroughChannel(Csv.decodeSchemaString(Person)({ headers: true })),
    Stream.runCollect
  )
)
people // => [{ name: "Alice", age: 32, nickname: "Al" }, { name: "Smith, Bob", age: 41 }]

// Writing: columns fixes the order, headers writes the first row.
const csv = await Effect.runPromise(
  Stream.fromIterable(people).pipe(
    Stream.pipeThroughChannel(Csv.encodeSchemaString(Person)({ headers: true, newline: "\n" })),
    Stream.runCollect,
    Effect.map((parts) => parts.join(""))
  )
)
csv // => 'name,age,nickname\nAlice,32,Al\n"Smith, Bob",41,\n'
```

Without a schema use `Csv.decodeString({ headers: true })` (records are
`Record<string, string>`) or no options (records are `ReadonlyArray<string>`).
Byte variants (`Csv.decode`, `encode`, `decodeSchema`, `encodeSchema`) work on
`Uint8Array`. Options: `delimiter`, `ignoreEmptyLines`, `maxRecordSize` (default
1 MiB) on decode; `delimiter`, `newline` (default `"\r\n"`), `columns`, `headers` on encode.

## Streaming a big JSON array (`JsonArray`)

`JSON.parse` of a 500 MB `[ ... ]` response holds it all. `JsonArray` emits one
element at a time, and `pointer` (an RFC 6901 JSON Pointer) reaches into an
envelope like `{ "total": 2, "items": [ ... ] }`. Errors are `JsonArrayError`.

```ts import.meta.vitest name="references/encoding/formats.md#2"
import { Effect, Schema, Stream } from "effect"
import { JsonArray } from "effect/encoding"

const Item = Schema.Struct({ id: Schema.Number })

const chunks = Stream.make("{\"total\":2,\"items\":[{\"id\":1},{\"i", "d\":2}]}")

const items = await Effect.runPromise(
  chunks.pipe(
    Stream.pipeThroughChannel(JsonArray.decodeSchemaString(Item)({ pointer: "/items" })),
    Stream.runCollect
  )
)
items // => [{ id: 1 }, { id: 2 }]
```

Also `JsonArray.decodeString`/`decode` (unknown elements), `encodeString`/`encode`
and `encodeSchemaString` to write a stream as one JSON array. Limits: `maxDepth`
(default 1000) and `maxElementSize` (default 16 MiB).

## TOML, JSON5 and JSONC (`Toml`, `Json5`, `Jsonc`) return `Result`, they do not throw

Unlike `Yaml.parse` (which throws `SyntaxError`), these return
`Result<_, EncodingError>`: `Toml.parse` in 4.1 (it threw in 4.0.0), `Json5.parse` and
`Jsonc.parse` since 4.1.2. Use `Effect.fromResult`, then a Schema, exactly as for `Base64`.
JSONC allows comments and a leading BOM (tsconfig-style files); JSON5 also allows
trailing commas, unquoted keys, single quotes and hex numbers.

```ts import.meta.vitest name="references/encoding/formats.md#3"
import { Effect, Result, Schema } from "effect"
import { Json5, Jsonc } from "effect/encoding"

const Settings = Schema.Struct({ port: Schema.Int })

const readSettings = (text: string) =>
  Effect.fromResult(Jsonc.parse(text)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Settings))
  )

const ok = await Effect.runPromise(readSettings("{ /* dev */ \"port\": 8080 }"))
ok // => { port: 8080 }

const trailing = Result.isFailure(Jsonc.parse("{ \"port\": 8080, }"))
trailing // => true

const five = Json5.parse("{ port: 8080, }")
five // => Result.succeed({ port: 8080 })
```

## XML (`Xml`)

A tokenizer, not a DOM: `Xml.decodeString()` turns text chunks into events
(`StartElement`, `Text`, `EndElement`, ...), `Xml.elements(path)` collects repeated
elements at a path into small trees, and `Xml.encodeString()` writes events back
with correct escaping. Entities other than the five predefined ones are rejected,
and `maxTokenSize` / `maxDepth` bound hostile input. Errors are `XmlError`.

```ts import.meta.vitest name="references/encoding/formats.md#4"
import { Effect, Stream } from "effect"
import { Xml } from "effect/encoding"

const feed = "<rss><channel><item><title>First</title></item><item><title>A &amp; B</title></item></channel></rss>"

const titles = await Effect.runPromise(
  Stream.make(feed).pipe(
    Stream.pipeThroughChannel(Xml.decodeString()),
    Stream.pipeThroughChannel(Xml.elements(["rss", "channel", "item"])),
    Stream.map((item) => item.children.map((child) => typeof child === "string" ? child : child.children.join(""))),
    Stream.runCollect
  )
)
titles // => [["First"], ["A & B"]]
```

## tar and zip archives (`Tar`, `Zip`)

Both are channels between a stream of entries and a stream of bytes, and
bodies are themselves streams. `Tar.file(path, content)`, `Tar.directory`,
`Tar.fileStream` (and the `Zip` equivalents) build entries; `Tar.encode()` /
`Zip.encode()` write; `Tar.decode()` / `Zip.decode()` read.

```ts import.meta.vitest name="references/encoding/formats.md#5"
import { Effect, Stream } from "effect"
import { Zip } from "effect/encoding"

const archive = Stream.make(
  Zip.directory("docs"),
  Zip.file("docs/readme.txt", "Hello, zip!")
).pipe(Stream.pipeThroughChannel(Zip.encode()))

// Read each body WHILE the entry stream runs (mapEffect); after the entry
// stream ends every body fails with BodyConsumed.
const listing = await Effect.runPromise(
  archive.pipe(
    Stream.pipeThroughChannel(Zip.decode()),
    Stream.mapEffect((entry) =>
      Stream.mkString(Stream.decodeText(entry.body)).pipe(
        Effect.map((text) => `${entry.header.path} ${JSON.stringify(text)}`)
      )
    ),
    Stream.runCollect
  )
)
listing // => ['docs/ ""', 'docs/readme.txt "Hello, zip!"']
```

Security: decoded paths are returned as written (absolute, `..`, symlink entries).
Validate them (for example with `Path.basename` or an allow-list) before writing
to disk, and for zip bound the work on untrusted archives by checking `header.size`
(deflate can expand about a thousand times). Deflated zip entries need
`CompressionStream("deflate-raw")` at runtime; `method: "Store"` does not.

## Byte helpers (`Bytes`)

`import { Bytes } from "effect"`: `Bytes.concat(chunks)`, `Bytes.Equivalence` and
`Bytes.Order` for `Uint8Array` values (use these instead of hand-rolled loops).
