// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import {
	Cause,
	Clock,
	ConfigProvider,
	Effect,
	Fiber,
	Layer,
	Logger,
	Option,
	Redacted,
	References,
	Schema,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as Lark from "../src/app/Lark.ts"
import * as LarkConfiguration from "../src/configuration/LarkConfiguration.ts"

const settings: Lark.Options = {
	webhookUrl: Redacted.make(
		"https://open.larksuite.com/open-apis/bot/v2/hook/test-hook",
	),
	signingSecret: Redacted.make("signing-secret"),
	environment: "test",
	version: "revision-1",
	instance: "instance-1",
	intervalMs: 0,
}
const Body = Schema.Struct({
	msg_type: Schema.Literal("text"),
	content: Schema.Struct({ text: Schema.String }),
	timestamp: Schema.optionalKey(Schema.String),
	sign: Schema.optionalKey(Schema.String),
})
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body))

test("Lark keeps local logs, signs safe events and sends out repeated failures", async () => {
	let sent: ReadonlyArray<typeof Body.Type> = []
	let local = 0
	const client = HttpClient.make((request) =>
		Effect.sync(() => {
			assert.equal(request.body._tag, "Uint8Array")
			if (request.body._tag === "Uint8Array")
				sent = [
					...sent,
					decodeBody(new TextDecoder().decode(request.body.body)),
				]
			return HttpClientResponse.fromWeb(request, Response.json({ code: 0 }))
		}),
	)
	const error = new Error("secret user content: Bearer private-token")
	error.stack = `Error: secret user content\n    at code (https://example.com/${"a".repeat(300)}.ts:12:34)`
	const cause = Cause.fail(error)
	const log = Effect.logError("User prompt and private-token", cause).pipe(
		Effect.annotateLogs({
			source: "turn",
			operation: "turn.execute",
			sessionId: "session-1",
			turnId: "turn-1",
			ignored: "private-token",
		}),
	)
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* log
			yield* log.pipe(
				Effect.annotateLogs({ sessionId: "session-2", turnId: "turn-2" }),
			)
			yield* Effect.logInfo("Not an alert")
			yield* Effect.logError("Excluded").pipe(
				Effect.annotateLogs({ "lark.exclude": true }),
			)
		}).pipe(
			Effect.provide(
				Lark.layer(settings).pipe(
					Layer.provideMerge(
						Logger.layer([
							Logger.make(() => {
								local++
							}),
						]),
					),
					Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
				),
			),
		),
	)
	assert.equal(local, 4)
	assert.equal(sent.length, 2)
	const first = sent[0]!
	assert.ok(
		(first.content.text
			.split("\n")
			.find((line) => line.startsWith("location: "))?.length ?? 0) <= 170,
	)
	assert.match(first.content.text, /operation: turn.execute/)
	assert.match(first.content.text, /sessionId: session-1/)
	assert.match(sent[1]!.content.text, /additionalOccurrences: 1/)
	assert.doesNotMatch(
		JSON.stringify(sent),
		/private-token|User prompt|secret user content|ignored/,
	)
	assert.equal(
		first.sign,
		createHmac("sha256", `${first.timestamp}\nsigning-secret`)
			.update("")
			.digest("base64"),
	)
})

test("Lark retries temporary HTTP and business errors but stops on permanent or invalid results", async () => {
	for (const [status, body, expected] of [
		[503, {}, 3],
		[429, {}, 3],
		[200, { code: 9499 }, 3],
		[200, { code: 19021 }, 1],
		[403, {}, 1],
		[200, {}, 1],
		[200, { code: "0" }, 1],
		[200, { StatusCode: 0 }, 1],
	] as const) {
		let attempts = 0
		let warnings = 0
		const client = HttpClient.make((request) =>
			Effect.sync(() => {
				attempts++
				return HttpClientResponse.fromWeb(
					request,
					Response.json(body, { status }),
				)
			}),
		)
		await Effect.runPromise(
			Effect.logError("Failure").pipe(
				Effect.provide(
					Lark.layer(settings).pipe(
						Layer.provideMerge(
							Logger.layer([
								Logger.make((log) => {
									if (log.logLevel === "Warn") warnings++
								}),
							]),
						),
						Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
					),
				),
			),
		)
		assert.equal(attempts, expected)
		assert.equal(warnings, 1)
	}
})

test("Lark limits queued notifications and aggregation keys and logs how many it drops", async () => {
	let delivered = 0
	let dropped = 0
	const client = HttpClient.make((request) =>
		Effect.sync(() => {
			delivered++
			return HttpClientResponse.fromWeb(request, Response.json({ code: 0 }))
		}),
	)
	await Effect.runPromise(
		Effect.gen(function* () {
			for (let n = 0; n < 10; n++)
				yield* Effect.logError("Failure").pipe(
					Effect.annotateLogs({ operation: `operation.${n}` }),
				)
		}).pipe(
			Effect.provide(
				Lark.layer({ ...settings, capacity: 2, aggregationCapacity: 3 }).pipe(
					Layer.provideMerge(
						Logger.layer([
							Logger.make((log) => {
								const annotations = log.fiber.getRef(
									References.CurrentLogAnnotations,
								)
								if (typeof annotations["count"] === "number")
									dropped += annotations["count"]
							}),
						]),
					),
					Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
				),
			),
		),
	)
	assert.ok(delivered <= 3)
	assert.equal(delivered + dropped, 10)
})

test("Lark ends aggregation windows and spaces out attempts with the Effect clock", async () => {
	let times: ReadonlyArray<number> = []
	let texts: ReadonlyArray<string> = []
	const client = HttpClient.make((request) =>
		Effect.gen(function* () {
			times = [...times, yield* Clock.currentTimeMillis]
			if (request.body._tag === "Uint8Array")
				texts = [
					...texts,
					decodeBody(new TextDecoder().decode(request.body.body)).content.text,
				]
			return HttpClientResponse.fromWeb(request, Response.json({ code: 0 }))
		}),
	)
	await Effect.runPromise(
		Effect.gen(function* () {
			const work = Effect.gen(function* () {
				yield* Effect.logError("Failure")
				yield* Effect.logError("Failure")
				yield* Effect.sleep(2100)
			}).pipe(
				Effect.provide(
					Lark.layer({ ...settings, windowMs: 1000, intervalMs: 1500 }).pipe(
						Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
					),
				),
			)
			const fiber = yield* Effect.forkChild(work)
			yield* TestClock.adjust(3000)
			yield* Fiber.join(fiber)
		}).pipe(Effect.provide(TestClock.layer())),
	)
	assert.deepEqual(times, [0, 1500])
	assert.match(texts[1]!, /additionalOccurrences: 1/)
})

test("Lark shutdown interrupts an unavailable destination at its deadline", async () => {
	let interrupted = false
	const client = HttpClient.make(() =>
		Effect.never.pipe(
			Effect.onInterrupt(() =>
				Effect.sync(() => {
					interrupted = true
				}),
			),
		),
	)
	await Effect.runPromise(
		Effect.gen(function* () {
			const fiber = yield* Effect.logError("Failure").pipe(
				Effect.provide(
					Lark.layer({
						...settings,
						requestTimeoutMs: 60_000,
						shutdownTimeoutMs: 5000,
					}).pipe(
						Layer.provideMerge(Logger.layer([])),
						Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
					),
				),
				Effect.forkChild,
			)
			yield* TestClock.adjust(5000)
			yield* Fiber.join(fiber)
		}).pipe(Effect.provide(TestClock.layer())),
	)
	assert.equal(interrupted, true)
})

test("Lark configuration is optional, redacted and rejects invalid destinations without leaking them", async () => {
	const load = (values: Readonly<Record<string, string>>) =>
		Effect.runPromiseExit(
			LarkConfiguration.load.pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown(values),
				),
			),
		)
	for (const values of [{}, { OPENBOT_LARK_WEBHOOK_URL: "" }]) {
		const exit = await load(values)
		assert.equal(exit._tag, "Success")
		if (exit._tag === "Success") assert.ok(Option.isNone(exit.value))
	}
	const valid = await load({
		OPENBOT_LARK_WEBHOOK_URL: Redacted.value(settings.webhookUrl),
	})
	assert.equal(valid._tag, "Success")
	if (valid._tag === "Success" && Option.isSome(valid.value))
		assert.equal(String(valid.value.value.webhookUrl), "<redacted>")
	const invalid = await load({
		OPENBOT_LARK_WEBHOOK_URL: "http://example.com/private-token",
	})
	assert.equal(invalid._tag, "Failure")
	if (invalid._tag === "Failure")
		assert.doesNotMatch(
			Cause.pretty(invalid.cause),
			/private-token|example.com/,
		)
})

test("Lark limits timed-out attempts with the Effect clock", async () => {
	let times: ReadonlyArray<number> = []
	const client = HttpClient.make(() =>
		Effect.gen(function* () {
			times = [...times, yield* Clock.currentTimeMillis]
			return yield* Effect.never
		}),
	)
	await Effect.runPromise(
		Effect.gen(function* () {
			const fiber = yield* Effect.logError("Failure").pipe(
				Effect.provide(
					Lark.layer({
						...settings,
						intervalMs: 1000,
						shutdownTimeoutMs: 10_000,
					}).pipe(
						Layer.provideMerge(Logger.layer([])),
						Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
					),
				),
				Effect.forkChild,
			)
			yield* TestClock.adjust(6000)
			yield* Fiber.join(fiber)
		}).pipe(Effect.provide(TestClock.layer())),
	)
	assert.deepEqual(times, [0, 2000, 4000])
})
