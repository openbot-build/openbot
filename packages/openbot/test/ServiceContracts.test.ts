import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { check } from "../../../scripts/service-contracts.ts"

const root = `${import.meta.dirname}/service-fixture`
const file = `${root}/Service.ts`
const testContract = (code: string, other = "") => {
	const files: Readonly<Record<string, string>> = {
		[`${root}/tsconfig.json`]:
			'{"compilerOptions":{"module":"nodenext","strict":true},"files":["Service.ts","Shape.ts"]}',
		[file]: code,
		[`${root}/Shape.ts`]: other,
	}
	return check([file], {
		fs: {
			readFile: (path) => files[path],
			fileExists: (path) => (path in files ? true : undefined),
			directoryExists: (path) => (path === root ? true : undefined),
		},
	})
}

describe("service contracts", () => {
	it.effect("rejects a service type taken from its constructor", () =>
		Effect.gen(function* () {
			const findings = yield* testContract(`
import { Context, Effect } from "effect"
const make = Effect.succeed({ read: Effect.succeed("value") })
class Store extends Context.Service<Store, Effect.Success<typeof make>>()("Store") {}
`)
			assert.lengthOf(findings, 1)
			assert.strictEqual(findings[0]?.line, 4)
		}),
	)
	it.effect("follows import and type aliases", () =>
		Effect.gen(function* () {
			const findings = yield* testContract(
				`
import * as C from "effect/Context"
import type { Shape } from "./Shape.ts"
class Store extends C.Service<Store, Shape>()("Store") {}
`,
				`
import { Effect } from "effect"
const make = () => Effect.succeed({ read: Effect.succeed("value") })
type Result = ReturnType<typeof make>
export type Shape = Effect.Success<Result>
`,
			)
			assert.lengthOf(findings, 1)
		}),
	)
	it.effect("rejects a constructor option that supplies the service type", () =>
		Effect.gen(function* () {
			const findings = yield* testContract(`
import { Context, Effect } from "effect"
class Store extends Context.Service<Store>()("Store", {
 make: Effect.succeed({ read: Effect.succeed("value") })
}) {}
`)
			assert.lengthOf(findings, 1)
		}),
	)
	it.effect("accepts declared methods and schema types", () =>
		Effect.gen(function* () {
			const findings = yield* testContract(`
import { Context, Effect, Schema } from "effect"
const Item = Schema.Struct({ name: Schema.String })
interface Shape { readonly read: () => Effect.Effect<typeof Item.Type> }
class Store extends Context.Service<Store, Shape>()("Store") {}
class Current extends Context.Service<Current, typeof Item.Type>()("Current") {}
// Context.Service<Fake, Effect.Success<typeof make>>() is only a comment.
const text = "Context.Service<Fake, Effect.Success<typeof make>>()"
`)
			assert.isEmpty(findings)
		}),
	)
	it.effect("checks a service made with a named import", () =>
		Effect.gen(function* () {
			const findings = yield* testContract(`
import { Service as Key } from "effect/Context"
import { Effect } from "effect"
const make = Effect.succeed({ value: "value" })
const Store = Key<Effect.Success<typeof make>>("Store")
`)
			assert.lengthOf(findings, 1)
		}),
	)
	it.effect("keeps helper inference outside service contracts", () =>
		Effect.gen(function* () {
			const findings = yield* testContract(`
import { Context, Effect } from "effect"
const make = Effect.succeed({ value: "value" })
type Local = Effect.Success<typeof make>
const helper = (value: Local) => value
interface Shape { readonly read: () => Effect.Effect<string> }
class Store extends Context.Service<Store, Shape>()("Store") {}
`)
			assert.isEmpty(findings)
		}),
	)
	it.effect("fails when the compiler cannot read a file", () =>
		Effect.gen(function* () {
			const result = yield* check([`${root}/Missing.ts`]).pipe(Effect.result)
			assert.strictEqual(result._tag, "Failure")
		}),
	)
	it.effect("rejects a service with no known shape", () =>
		Effect.gen(function* () {
			const findings = yield* testContract(`
import { Context } from "effect"
class First extends Context.Service<First, any>()("First") {}
class Second extends Context.Service<Second, unknown>()("Second") {}
`)
			assert.lengthOf(findings, 2)
		}),
	)
})
