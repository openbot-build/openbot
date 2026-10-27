import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { ExecutionsApi, FailureApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Cause, Effect, Layer, Logger, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/http-api"
import * as Failures from "../src/errors/Failures.ts"
import * as Boundary from "../src/errors/HttpBoundary.ts"
import * as Reporting from "../src/errors/Reporting.ts"
import { Records } from "../src/errors/Records.ts"
import { codec, snapshot } from "../src/errors/Snapshot.ts"

class Inside extends Schema.TaggedError<
	Inside,
	{ readonly brand: unique symbol }
>()("Inside", { detail: Schema.String }) {}
class Unavailable extends Schema.TaggedError<
	Unavailable,
	{ readonly brand: unique symbol }
>()("Unavailable", {}) {}
class Rejected extends Schema.TaggedError<
	Rejected,
	{ readonly brand: unique symbol }
>()("Rejected", {}) {}
class BadInput extends Schema.TaggedError<
	BadInput,
	{ readonly brand: unique symbol }
>()("BadInput", {}) {}
class Api extends HttpApi.make("FailureBoundaryTest")
	.add(
		HttpApiGroup.make("test").add(
			HttpApiEndpoint.get("mapped", "/mapped", {
				success: Schema.String,
				error: Unavailable.pipe(HttpApiSchema.status(503)),
			}),
			HttpApiEndpoint.get("rejected", "/rejected", {
				success: Schema.String,
				error: Rejected.pipe(HttpApiSchema.status(403)),
			}),
			HttpApiEndpoint.get("fault", "/fault", { success: Schema.String }),
			HttpApiEndpoint.get("thrown", "/thrown", { success: Schema.String }),
			HttpApiEndpoint.get("mixed", "/mixed", {
				success: Schema.String,
				error: Rejected.pipe(HttpApiSchema.status(403)),
			}),
			HttpApiEndpoint.get("badInput", "/bad-input", {
				success: Schema.String,
				error: BadInput.pipe(HttpApiSchema.status(400)),
			}),
			HttpApiEndpoint.get("saved", "/saved", {
				success: Schema.String,
				error: ExecutionsApi.ExecutionUnavailable.pipe(
					HttpApiSchema.status(503),
				),
			}),
			HttpApiEndpoint.post("input", "/input", {
				payload: Schema.Struct({ value: Schema.Finite }),
				success: Schema.String,
			}),
		),
	)
	.middleware(FailureApi.FailureBoundary) {}

it.live(
	"HTTP faults keep their sealed cause ID and client rejections keep their meaning",
	() => {
		let saved: ReadonlyArray<Cause.Cause<unknown>> = []
		let logs: ReadonlyArray<string> = []
		const known = Execution.ErrorId.make("00000000-0000-4000-8000-000000000001")
		const records = Layer.succeed(Records, {
			record: (cause, category) =>
				Effect.sync(() => {
					saved = [...saved, cause]
					return {
						errorId: Execution.ErrorId.make(`test-failure-${saved.length}`),
						category,
					}
				}),
		})
		const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
			handlers
				.handle("mapped", () =>
					Effect.fail(Inside.make({ detail: "private-driver-secret" })).pipe(
						Failures.replace("The store failed.", () => Unavailable.make({})),
					),
				)
				.handle("rejected", () => Effect.fail(Rejected.make({})))
				.handle("fault", () => Effect.die(new Error("private-provider-secret")))
				.handle("thrown", () =>
					Effect.sync(() => {
						assert.fail("private-thrown-secret")
					}),
				)
				.handle("mixed", () =>
					Effect.failCause(
						Cause.combine(
							Cause.fail(Rejected.make({})),
							Cause.die(new Error("private-mixed-secret")),
						),
					),
				)
				.handle("badInput", () => Effect.fail(BadInput.make({})))
				.handle("saved", () =>
					Effect.fail(
						ExecutionsApi.ExecutionUnavailable.make({ errorId: known }),
					),
				)
				.handle("input", () => Effect.succeed("ok")),
		)
		const routes = Layer.merge(
			HttpApiBuilder.layer(Api).pipe(
				Layer.provide(handlers),
				Layer.provide(Boundary.layer),
			),
			Reporting.layerHttp,
		)
		const server = HttpRouter.serve(routes, {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.provide(records),
			Layer.provide(
				Logger.layer([
					Logger.make((log) => {
						logs = [...logs, Cause.pretty(log.cause), String(log.message)]
					}),
				]),
			),
			Layer.provideMerge(NodeHttpServer.layerTest),
			Layer.provide(NodeServices.layer),
		)
		return Effect.gen(function* () {
			for (const [path, secret] of [
				["/mapped", "private-driver-secret"],
				["/fault", "private-provider-secret"],
				["/thrown", "private-thrown-secret"],
				["/mixed", "private-mixed-secret"],
			]) {
				const response = yield* HttpClient.get(path!)
				assert.strictEqual(response.status, 503)
				const body = yield* response.json
				const failure = yield* Schema.decodeUnknownEffect(
					FailureApi.RequestFailed,
				)(body)
				assert.strictEqual(failure.category, "unavailable")
				assert.strictEqual(
					response.headers[Boundary.errorIdHeader],
					failure.errorId,
				)
				assert.notMatch(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
						body,
					),
					/private-/,
				)
				const diagnostic = yield* saved[saved.length - 1]!.pipe(
					snapshot,
					Schema.encodeEffect(codec),
				)
				assert.include(diagnostic, secret!)
			}
			const rejected = yield* HttpClient.get("/rejected")
			assert.strictEqual(rejected.status, 403)
			assert.deepStrictEqual(yield* rejected.json, { _tag: "Rejected" })
			const badInput = yield* HttpClient.get("/bad-input")
			assert.strictEqual(badInput.status, 400)
			assert.deepStrictEqual(yield* badInput.json, { _tag: "BadInput" })
			const mixed = saved[3]!
			assert.strictEqual(mixed.reasons.length, 2)
			assert.isTrue(Cause.hasFails(mixed))
			assert.isTrue(Cause.hasDies(mixed))
			const prior = yield* HttpClient.get("/saved")
			assert.strictEqual(prior.headers[Boundary.errorIdHeader], known)
			const invalid = yield* HttpClient.post("/input")
			assert.strictEqual(invalid.status, 400)
			const client = yield* HttpClient.HttpClient
			for (const body of ['{"value":', '{"value":"private-invalid-input"}']) {
				const malformed = yield* client.execute(
					HttpClientRequest.post("/input").pipe(
						HttpClientRequest.bodyText(body, "application/json"),
					),
				)
				assert.strictEqual(malformed.status, 400)
				assert.strictEqual(malformed.headers[Boundary.errorIdHeader], undefined)
			}
			assert.strictEqual(saved.length, 4)
			assert.notMatch(Arr.join(logs, "\n"), /private-/)
		}).pipe(Effect.provide(server))
	},
)
