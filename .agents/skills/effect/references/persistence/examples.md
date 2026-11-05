# Effect persistence: worked examples

## Typed key-value state, storage swapped by Layer

```ts import.meta.vitest name="references/persistence/examples.md#1"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"

// Version the stored shape: persisted data outlives the code that wrote it.
// Adding an optional field is safe; renaming one needs a new key or a migration.
const Settings = Schema.Struct({
  theme: Schema.Literals(["light", "dark"]),
  pageSize: Schema.Int
})

export const loadSettings = Effect.gen(function*() {
  const kv = yield* KeyValueStore.KeyValueStore
  // prefix gives each feature its own key namespace on the shared store
  const settings = KeyValueStore.toSchemaStore(KeyValueStore.prefix("settings/v1/")(kv), Settings)

  const existing = yield* settings.get("ada") // Option<Settings>; decoding errors are SchemaError
  if (existing._tag === "Some") return existing.value
  const defaults = { theme: "light", pageSize: 20 } as const
  yield* settings.set("ada", defaults)
  return defaults
})

// Same program, different durability. Tests and demos use memory...
export const runInMemory = loadSettings.pipe(Effect.provide(KeyValueStore.layerMemory))

// ...production writes one file per key under a directory (clear() deletes the directory
// recursively, so give it a directory nothing else uses).
export const runOnDisk = loadSettings.pipe(
  Effect.provide(KeyValueStore.layerFileSystem("./.data/kv").pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
  ))
)

const settings = await Effect.runPromise(runInMemory)
settings // => { theme: "light", pageSize: 20 }
```

`KeyValueStore.layerSql({ table? })` (needs a `SqlClient`) and
`layerStorage(() => localStorage)` are the other built-in layers. Errors are
`KeyValueStoreError` (a `Data.TaggedError` with `method` and `key`): decide at
the service edge whether callers can recover (usually not: `Effect.orDie`).
