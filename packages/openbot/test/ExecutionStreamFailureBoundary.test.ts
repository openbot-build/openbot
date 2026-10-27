import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { AuthApi, ExecutionsApi, FailureApi } from "@openbot-build/api"
import { Execution, Identity } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Layer,
	Logger,
	Redacted,
	Result,
	Schema,
	Stream,
} from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiMiddleware,
} from "effect/http-api"
import * as Boundary from "../src/errors/HttpBoundary.ts"
import { Records } from "../src/errors/Records.ts"
import * as Reporting from "../src/errors/Reporting.ts"
import { codec, snapshot } from "../src/errors/Snapshot.ts"
import { Commands } from "../src/execution/Commands.ts"
import * as Handlers from "../src/execution/HttpHandlers.ts"
import * as HttpEvents from "../src/execution/HttpEvents.ts"

const id = Execution.Id.make("stream-failure-test")
const errorId = Execution.ErrorId.make("stream-error-test")
const api = HttpApi.make("openbot-api")
	.add(ExecutionsApi.ExecutionsApi)
	.middleware(FailureApi.FailureBoundary)
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const record: Execution.Record = {
	id,
	resource: { kind: "Chat", id: "chat" },
	status: "running",
	sequence: 1,
	createdAt: 1,
	updatedAt: 1,
	failure: null,
}
const event: Execution.Event = {
	executionId: id,
	sequence: 1,
	createdAt: 1,
	body: { _tag: "Text", step: "model", attempt: 1, text: "Saved text" },
}
const auth = Layer.succeed(AuthApi.BotAuth, {
	token: (effect) => Effect.provideService(effect, Identity, actor),
	session: (effect) => Effect.provideService(effect, Identity, actor),
})
const check = (
	tail: Stream.Stream<
		Execution.Event,
		Execution.StorageError | Execution.Forbidden
	>,
	expected:
		| "fault"
		| "encoding"
		| "forbidden"
		| "recorder"
		| "failure_encoding"
		| "client" = "fault",
) => {
	let saved: ReadonlyArray<Cause.Cause<unknown>> = []
	let logs: ReadonlyArray<string> = []
	const records = Layer.succeed(Records, {
		record: (cause, category, executionId) =>
			Effect.gen(function* () {
				assert.strictEqual(executionId, id)
				saved = [...saved, cause]
				if (expected === "recorder")
					return yield* Execution.StorageError.make({
						cause: Redacted.make(
							Cause.combine(
								cause,
								Cause.die(new Error("private-record-secret")),
							),
						),
					})
				if (expected === "failure_encoding")
					return {
						category,
						get errorId() {
							return assert.fail("private-failure-encoding-secret")
						},
					}
				return { errorId, category }
			}),
	})
	const commands = Layer.mock(Commands, {
		get: () => Effect.succeed(record),
		observe: () => Stream.make(event).pipe(Stream.concat(tail)),
	})
	const routes = Layer.merge(
		HttpApiBuilder.layer(api).pipe(
			Layer.provide(Handlers.layer),
			Layer.provide(Boundary.layer),
		),
		Reporting.layerHttp,
	)
	const server = HttpRouter.serve(routes, {
		disableLogger: true,
		disableListenLog: true,
	}).pipe(
		Layer.provide(Layer.mergeAll(records, commands, auth)),
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
		const request = HttpClient.get(`/v1/executions/${id}/observe`, {
			headers: { authorization: "Bearer token" },
		})
		if (expected === "recorder" || expected === "failure_encoding") {
			const result = yield* request.pipe(
				Effect.flatMap((response) => response.text),
				Effect.result,
			)
			assert.isTrue(Result.isFailure(result))
			assert.strictEqual(saved.length, 1)
			assert.notMatch(Arr.join(logs, "\n"), /private-/)
			return
		}
		const response = yield* request
		assert.strictEqual(response.status, 200)
		const body = yield* response.text
		assert.include(body, "Saved text")
		assert.include(body, "effect/http-api/stream/failure")
		assert.notMatch(body, /private-/)
		if (expected === "forbidden") {
			assert.include(body, '"_tag":"ExecutionForbidden"')
			assert.strictEqual(saved.length, 0)
			return
		}
		assert.include(body, `"errorId":"${errorId}"`)
		assert.include(body, '"category":"unavailable"')
		assert.strictEqual(saved.length, 1)
		const diagnostic = yield* saved[0]!.pipe(
			snapshot,
			Schema.encodeEffect(codec),
		)
		assert.include(
			diagnostic,
			expected === "encoding" ? "finite number" : "private-stream-secret",
		)
		assert.notMatch(Arr.join(logs, "\n"), /private-/)
		if (expected === "client") {
			const client = yield* HttpApiClient.make(api).pipe(
				Effect.provide(
					HttpApiMiddleware.layerClient(AuthApi.BotAuth, ({ request, next }) =>
						next(request.pipe(HttpClientRequest.bearerToken("token"))),
					),
				),
			)
			const failure = yield* client.executions
				.observe({ params: { executionId: id }, query: {} })
				.pipe(Effect.flatMap(Stream.runDrain), Effect.flip)
			assert.isTrue(Schema.is(FailureApi.RequestFailed)(failure))
			if (Schema.is(FailureApi.RequestFailed)(failure)) {
				assert.strictEqual(failure.category, "unavailable")
				assert.strictEqual(failure.errorId, errorId)
			}
		}
	}).pipe(Effect.provide(server))
}

it.live(
	"a stream storage fault has one safe error reference after output starts",
	() =>
		check(
			Stream.fail(
				Execution.StorageError.make({
					cause: Redacted.make(Cause.die(new Error("private-stream-secret"))),
				}),
			),
		),
)

it.live(
	"a stream defect has one safe error reference after output starts",
	() => check(Stream.die(new Error("private-stream-secret"))),
)

it.live(
	"a stream keeps the full mixed cause behind one safe error reference",
	() =>
		check(
			Stream.failCause(
				Cause.combine(
					Cause.fail(Execution.Forbidden.make({})),
					Cause.die(new Error("private-stream-secret")),
				),
			),
		),
)

it.live("a stream encoding fault has one safe error reference", () =>
	check(
		Stream.succeed({
			...event,
			sequence: 2,
			createdAt: Number.NaN,
			body: {
				_tag: "Text",
				step: "model",
				attempt: 1,
				text: "private-stream-secret",
			},
		}),
		"encoding",
	),
)

it.live("a revoked stream keeps its declared access error", () =>
	check(Stream.fail(Execution.Forbidden.make({})), "forbidden"),
)

it.live(
	"a failed stream recorder closes the connection without sending a defect",
	() => check(Stream.die(new Error("private-stream-secret")), "recorder"),
)

it.live(
	"a failure event encoding fault closes the connection without sending a defect",
	() =>
		check(Stream.die(new Error("private-stream-secret")), "failure_encoding"),
)

it.live("the typed HTTP client reads a safe stream failure", () =>
	check(Stream.die(new Error("private-stream-secret")), "client"),
)

it.effect(
	"closing an observation keeps interruption without saving a fault",
	() =>
		Effect.gen(function* () {
			let saved = 0
			const response = yield* HttpEvents.make.pipe(
				Effect.map((respond) =>
					respond(id, Stream.failCause(Cause.interrupt(1))),
				),
				Effect.provideService(
					Records,
					Records.of({
						record: (_cause, category) =>
							Effect.sync(() => {
								saved++
								return { category, errorId }
							}),
					}),
				),
			)
			assert.strictEqual(response.body._tag, "Stream")
			if (response.body._tag !== "Stream") return
			const exit = yield* response.body.stream.pipe(
				Stream.runDrain,
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
			assert.strictEqual(saved, 0)
		}),
)
