import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Schema, SchemaAST, String as Str } from "effect"
import { HttpApi, OpenApi } from "effect/http-api"
import { expect } from "vitest"
import { OpenBotApi } from "../src/OpenBotApi.ts"

/** The names of the fields of the params schema of an endpoint. */
const paramNames = (params: Schema.Top | undefined): ReadonlyArray<string> =>
	params !== undefined && SchemaAST.isObjects(params.ast)
		? Arr.map(params.ast.propertySignatures, (field) => String(field.name))
		: []

/** Each endpoint with its group, method and path. */
const endpoints = () => {
	const found: Array<{
		readonly group: string
		readonly name: string
		readonly method: string
		readonly path: string
		readonly params: ReadonlyArray<string>
	}> = []
	HttpApi.reflect(OpenBotApi, {
		onGroup: () => undefined,
		onEndpoint: ({ group, endpoint }) => {
			found.push({
				group: group.identifier,
				name: endpoint.identifier,
				method: endpoint.method,
				path: endpoint.path,
				params: paramNames(endpoint.params),
			})
		},
	})
	return found
}

describe("Contract", () => {
	// The server sends each request on to the feature that owns its group, by
	// the path of the endpoint. That works only when each path is plain text
	// and simple `:name` parameters.
	it("every path has only plain parts and simple parameters", () => {
		for (const endpoint of endpoints()) {
			const parts = Arr.filter(Str.split(endpoint.path, "/"), Str.isNonEmpty)
			for (const part of parts) {
				const where = `${endpoint.group}.${endpoint.name} ${endpoint.path}`
				if (Str.startsWith(":")(part)) {
					assert.match(part, /^:[A-Za-z][A-Za-z0-9]*$/, where)
					assert.include(endpoint.params, Str.slice(1)(part), where)
				} else assert.match(part, /^[A-Za-z0-9._~*-]+$/, where)
			}
		}
	})

	it("two endpoints never share a method and path", () => {
		const keys = Arr.map(
			endpoints(),
			(endpoint) => `${endpoint.method} ${endpoint.path}`,
		)
		assert.strictEqual(Arr.dedupe(keys).length, keys.length)
	})

	// A change of the public contract must be on purpose. Update the file with
	// `vitest run -u` and review the change.
	it.effect("the OpenAPI document stays the same", () =>
		Effect.gen(function* () {
			const document = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Unknown),
			)(OpenApi.fromApi(OpenBotApi))
			yield* Effect.promise(() =>
				expect(document).toMatchFileSnapshot("./snapshots/openapi.json"),
			)
		}),
	)
})
