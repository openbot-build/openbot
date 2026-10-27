import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Effect,
	Logger,
	Option,
	Redacted,
	Schema,
} from "effect"
import * as Client from "../src/connections/Client.ts"
import * as McpClient from "../src/connections/McpClient.ts"

const publicError = () =>
	Client.ClientError.make({
		reason: "Schema",
		issue: "The App result does not match its schema.",
	})
const encode = Schema.encodeEffect(Schema.fromJsonString(Client.ClientError))
const logs = () => {
	let lines: ReadonlyArray<unknown> = []
	return {
		read: () => lines,
		layer: Logger.layer([
			Logger.make((log) => {
				lines = [
					...lines,
					{ message: log.message, cause: Cause.pretty(log.cause) },
				]
			}),
		]),
	}
}
const privateCause = (error: unknown) =>
	Redacted.value(Option.getOrThrow(Client.errorCause(error)))

it.effect(
	"private protocol causes keep failures and defects outside the public schema",
	() =>
		Effect.gen(function* () {
			const original = publicError()
			const cause = Cause.combine(
				Cause.fail(new Error("private-failure")),
				Cause.die(new Error("private-defect")),
			)
			const error = Client.withCause(original, cause)
			assert.strictEqual(error, original)
			assert.strictEqual(privateCause(error), cause)
			assert.deepStrictEqual(
				Arr.map(privateCause(error).reasons, (reason) => reason._tag),
				["Fail", "Die"],
			)
			assert.notMatch(yield* encode(error), /private-/)
			assert.notMatch(Cause.pretty(Cause.fail(error)), /private-/)
			assert.isTrue(Option.isNone(Client.errorCause(publicError())))
			assert.isTrue(Option.isNone(Client.errorCause(null)))
		}),
)

it.effect(
	"an MCP schema throw stays private and keeps its original cause",
	() => {
		const output = logs()
		return Effect.gen(function* () {
			const error = yield* McpClient.decodeStandard<string>(
				() => {
					// @effect-rules-next-line throw -- The SDK schema factory can throw before it returns its validator.
					throw new Error("private-schema-throw")
				},
				{},
				publicError,
			).pipe(Effect.flip)
			assert.match(Cause.pretty(privateCause(error)), /private-schema-throw/)
			assert.notMatch(yield* encode(error), /private-/)
			yield* Effect.logWarning("The App schema check failed", Cause.fail(error))
			assert.notMatch(
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
					output.read(),
				),
				/private-/,
			)
		}).pipe(Effect.provide(output.layer))
	},
)

it.effect(
	"an MCP schema issue stays private and keeps the validator details",
	() => {
		const output = logs()
		return Effect.gen(function* () {
			const error = yield* McpClient.decodeStandard<string>(
				() => ({
					"~standard": {
						version: 1,
						vendor: "test",
						validate: () => ({ issues: [{ message: "private-schema-issue" }] }),
					},
				}),
				{},
				publicError,
			).pipe(Effect.flip)
			assert.match(Cause.pretty(privateCause(error)), /private-schema-issue/)
			assert.notMatch(yield* encode(error), /private-/)
			assert.notMatch(
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
					output.read(),
				),
				/private-/,
			)
		}).pipe(Effect.provide(output.layer))
	},
)
