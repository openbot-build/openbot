import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	References,
	Ref,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import { PluginsFile } from "@openbot-build/openbot/Parts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as TestHost from "./TestHost.ts"
import * as Failures from "./testing/Failures.ts"

/** Writes a plugins file in a new folder that goes away with the scope. */
const writeFile = (text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.join(yield* fs.makeTempDirectoryScoped(), "plugins.yml")
		yield* fs.writeFileString(file, text)
		return file
	})

const turnLimit = (maxSteps: number) =>
	`- id: turn-limiter\n  disabled: false\n  config:\n    maxSteps: ${maxSteps}\n`

/** A logger that keeps each line as JSON text, with its notes and its cause. */
const capture = () => {
	let lines: ReadonlyArray<string> = []
	const logger = Logger.make((line) => {
		lines = [
			...lines,
			PluginsFile.canonical({
				message: line.message,
				annotations: line.fiber.getRef(References.CurrentLogAnnotations),
				cause: String(line.cause),
			}),
		]
	})
	return { layer: Logger.layer([logger]), lines: () => lines }
}

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const answer = Stream.make(
	Response.makePart("text-start", { id: "answer" }),
	Response.makePart("text-delta", { id: "answer", delta: "Done." }),
	Response.makePart("text-end", { id: "answer" }),
	Response.makePart("finish", { reason: "stop", usage }),
)

/** True when a tool result comes after the last message of the person. */
const answered = (prompt: Prompt.Prompt) => {
	const last = Option.getOrElse(
		Arr.findLastIndex(prompt.content, (message) => message.role === "user"),
		() => -1,
	)
	return Arr.some(
		Arr.drop(prompt.content, last + 1),
		(message) =>
			message.role === "tool" &&
			Arr.some(message.content, (part) => part.type === "tool-result"),
	)
}

/**
 * A model that asks for a host tool in its first step and answers in its
 * second step. `before` runs before each request.
 */
const toolThenAnswer = (
	before: Effect.Effect<boolean> = Effect.succeed(true),
) =>
	LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt }) =>
			Stream.unwrap(
				Effect.map(before, (go): Stream.Stream<Response.StreamPartEncoded> =>
					!go
						? Stream.never
						: answered(prompt)
							? answer
							: Stream.make(
									Response.makePart("tool-call", {
										id: `limit-call-${prompt.content.length}`,
										name: "GetValue",
										params: { key: "limit" },
										providerExecuted: false,
									}),
									Response.makePart("finish", { reason: "tool-calls", usage }),
								),
				),
			),
	})

/** Signs in one person, and gives a call with their cookie and their Bot. */
const member = (host: BrowserHost.Host, publicOrigin: string, name: string) =>
	Effect.gen(function* () {
		const person = yield* host.login(name)
		const bot = yield* host.defaultBot(person.session)
		const send: Messages.Send = (path, method, body) =>
			Effect.flatMap(host.address, (address) =>
				Caller.withCookie({ address, publicOrigin })(
					person.session,
					path,
					method,
					body,
				),
			)
		return { send, bot }
	})

/** The text of the sealed error record of one execution. */
const recordOf = (host: BrowserHost.Host, executionId: string) =>
	host.run(
		Effect.gen(function* () {
			const rows = Arr.filter(
				yield* Failures.read,
				(row) => row.executionId === executionId,
			)
			assert.strictEqual(rows.length, 1)
			const row = rows[0]!
			const secrets = yield* Secrets
			return yield* secrets.open(row.cause, `failure:${row.id}`)
		}),
	)

const snapshot = (host: BrowserHost.Host) =>
	host.run(Effect.flatMap(BotFeatures, (features) => features.snapshot))

// The host runs real servers, so the tests need real time.
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "240 seconds",
})((it) => {
	it.effect(
		"the plugins file turns a limit on, and a Turn stops at the limit",
		() =>
			Effect.gen(function* () {
				const publicOrigin = "https://turn-limit.example.com"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* toolThenAnswer(),
					pluginsFile: yield* writeFile(turnLimit(1)),
				})
				assert.deepStrictEqual(
					Arr.last(yield* snapshot(host)),
					Option.some({
						id: "@openbot-build/plugin-turn-limiter",
						version: 1,
						settings: { maxSteps: 1 },
					}),
				)
				const { send, bot } = yield* member(host, publicOrigin, "turn-limit")
				const { receipt, view } = yield* Messages.talk(send, bot, "Read it")
				assert.strictEqual(view.response?.status, "failed")
				const record = yield* recordOf(host, receipt.executionId)
				assert.include(record, "BotFeatureStopped")
				assert.include(record, "@openbot-build/plugin-turn-limiter")
				assert.include(record, "ModelStepLimitExceeded")
				assert.match(record, /\["maxSteps",1\]/)
				// The record keeps the history of the Turn, so it can be large.
				assert.isBelow(record.length, 100_000)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"a Turn keeps the limit of its pin in a later phase when the config changes",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const started = yield* Deferred.make<void>()
				const restarted = yield* Ref.make(false)
				// The first request waits until the server stops.
				const model = yield* toolThenAnswer(
					Effect.gen(function* () {
						if (yield* Ref.get(restarted)) return true
						yield* Deferred.succeed(started, undefined)
						return false
					}),
				)
				const publicOrigin = "https://turn-limit-pin.example.com"
				const file = yield* writeFile(turnLimit(1))
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					pluginsFile: file,
				})
				const { send, bot } = yield* member(host, publicOrigin, "turn-pin")
				const first = yield* Messages.message(send, bot, "Read it")
				yield* Deferred.await(started)
				// The next start reads a new limit. The Turn runs on in a new phase.
				yield* fs.writeFileString(file, turnLimit(5))
				yield* Ref.set(restarted, true)
				yield* host.restart
				assert.deepStrictEqual(
					Arr.last(yield* snapshot(host)),
					Option.some({
						id: "@openbot-build/plugin-turn-limiter",
						version: 1,
						settings: { maxSteps: 5 },
					}),
				)
				const stopped = yield* Messages.settled(send, first.chat)
				assert.strictEqual(stopped.response?.id, first.turn)
				assert.strictEqual(stopped.response?.status, "failed")
				const record = yield* recordOf(host, first.executionId)
				assert.include(record, "ModelStepLimitExceeded")
				assert.match(record, /\["maxSteps",1\]/)
				// A new Turn pins the new limit, so it gets past its first step.
				const next = yield* Messages.send(send, first.chat, "Read it again")
				const done = yield* Messages.settled(send, first.chat)
				assert.strictEqual(done.response?.id, next.turn)
				assert.strictEqual(done.response?.status, "completed")
			}).pipe(Effect.scoped),
	)

	it.effect("time-limiter stops a Turn that runs too long", () =>
		Effect.gen(function* () {
			const publicOrigin = "https://time-limit.example.com"
			const host = yield* BrowserHost.start({
				publicOrigin,
				model: yield* toolThenAnswer(Effect.succeed(false)),
				pluginsFile: yield* writeFile(
					"- id: time-limiter\n  disabled: false\n  config:\n    maxDuration: 300\n",
				),
			})
			const { send, bot } = yield* member(host, publicOrigin, "time-limit")
			const { receipt, view } = yield* Messages.talk(send, bot, "Wait")
			assert.strictEqual(view.response?.status, "failed")
			const record = yield* recordOf(host, receipt.executionId)
			assert.include(record, "BotFeatureStopped")
			assert.include(record, "TimeLimitExceeded")
		}).pipe(Effect.scoped),
	)

	it.effect(
		"a limit plugin that is on with no good config does not start",
		() =>
			Effect.gen(function* () {
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const logs = capture()
				const start = (text: string) =>
					Effect.flatMap(writeFile(text), (file) =>
						Layer.build(TestHost.layer({ ...options, pluginsFile: file })).pipe(
							Effect.provide(logs.layer),
							Effect.scoped,
							Effect.flip,
						),
					)
				const shared = yield* Layer.build(TestHost.layerShared(options))
				const failed = (error: Effect.Success<ReturnType<typeof start>>) =>
					Effect.gen(function* () {
						assert.strictEqual(error._tag, "PluginsInactive")
						const fork = Arr.findFirst(
							error._tag === "PluginsInactive" ? error.forks : [],
							(fork) => fork.plugin === "@openbot-build/plugin-token-limiter",
						)
						assert.isTrue(Option.isSome(fork))
						if (Option.isNone(fork)) return
						assert.strictEqual(fork.value.state, "Failed")
						const errorId = fork.value.errorId
						assert.isDefined(errorId)
						const rows = yield* Failures.read.pipe(
							Effect.provideContext(shared),
						)
						assert.isTrue(Arr.some(rows, (row) => row.id === errorId))
					})
				yield* failed(yield* start("- id: token-limiter\n  disabled: false\n"))
				const value = "not-a-number-5821"
				yield* failed(
					yield* start(
						`- id: token-limiter\n  disabled: false\n  config:\n    maxTokens: "${value}"\n`,
					),
				)
				assert.isFalse(Arr.some(logs.lines(), Str.includes(value)))
				// A limit must be the same on every server, so it can not come from !env.
				const env = yield* start(
					"- id: token-limiter\n  disabled: false\n  config:\n    maxTokens: !env OPENBOT_TEST_LIMIT\n",
				)
				assert.strictEqual(env._tag, "PluginsFileInvalid")
				assert.include(
					env.message,
					"The config of this plugin can not use !env.",
				)
			}).pipe(Effect.scoped),
	)
})
