import { PgClient } from "@effect/sql-pg"
import * as TestDatabase from "@openbot-build/server-database/Testing"
import { FetchHttpClient } from "effect/http"
import { NodeServices, NodeCrypto } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Clock,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	References,
	Ref,
	String as Str,
	Redacted,
} from "effect"
import { Execution } from "@openbot-build/domain"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import { Secrets } from "@openbot-build/server-kernel/Secrets"
import * as BrowserHost from "../src/BrowserHost.ts"
import * as Caller from "../src/Caller.ts"
import * as Messages from "../src/Messages.ts"
import * as TestHost from "../src/TestHost.ts"
import * as Failures from "../src/Failures.ts"
import { toolsThenAnswer, waitFeature, waitPlugin } from "./LimitFixture.ts"

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
			// A logger runs outside of Effect, so it encodes at once.
			JSON.stringify({
				message: line.message,
				annotations: line.fiber.getRef(References.CurrentLogAnnotations),
				cause: String(line.cause),
			}),
		]
	})
	return { layer: Logger.layer([logger]), lines: () => lines }
}

/**
 * A model that asks for a host tool in its first step and answers in its
 * second step. `before` runs before each request.
 */
const toolThenAnswer = (
	before: Effect.Effect<boolean> = Effect.succeed(true),
) => toolsThenAnswer(1, () => before)

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

/** The public failure category of one execution. */
const categoryOf = (send: Messages.Send, executionId: string) =>
	Effect.map(
		Effect.flatMap(
			send(`/v1/executions/${executionId}`, "GET"),
			Caller.json(Execution.Record),
		),
		(record) => record.failure?.category,
	)

const turnLimiter = "@openbot-build/plugin-turn-limiter"

/**
 * Starts a Turn whose model request in step `step` waits for a restart of
 * the server. The restart builds the host again in the same process; the
 * test in LimitProcessRestart.test.ts starts a new process. The plugins file is `before` at the start and `after` at the
 * restart. The model asks for a tool twice and answers in its third step.
 * It gives the Chat when the Turn has come to rest after the restart.
 */
const restartInStep = (options: {
	readonly name: string
	readonly step: number
	readonly before: string
	readonly after: string
	readonly extra?: BrowserHost.Options["extra"]
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const started = yield* Deferred.make<void>()
		const restarted = yield* Ref.make(false)
		const model = yield* toolsThenAnswer(2, (results) =>
			Effect.gen(function* () {
				if (results !== options.step - 1 || (yield* Ref.get(restarted)))
					return true
				yield* Deferred.succeed(started, undefined)
				return false
			}),
		)
		const publicOrigin = `https://${options.name}.example.com`
		const file = yield* writeFile(options.before)
		const host = yield* BrowserHost.start({
			publicOrigin,
			model,
			pluginsFile: file,
			...(options.extra === undefined ? {} : { extra: options.extra }),
		})
		const { send, bot } = yield* member(host, publicOrigin, options.name)
		const first = yield* Messages.message(send, bot, "Read it twice")
		yield* Deferred.await(started)
		yield* fs.writeFileString(file, options.after)
		yield* Ref.set(restarted, true)
		yield* host.restart
		const view = yield* Messages.settled(send, first.chat)
		assert.strictEqual(view.response?.id, first.turn)
		return { host, send, first, view }
	})

// The host runs real servers, so the tests need real time.
layer(
	Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	{
		excludeTestServices: true,
		timeout: "240 seconds",
	},
)((it) => {
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
						id: turnLimiter,
						version: 1,
						settings: { maxSteps: 1 },
						missing: { _tag: "skip" as const },
					}),
				)
				const { send, bot } = yield* member(host, publicOrigin, "turn-limit")
				const { receipt, view } = yield* Messages.talk(send, bot, "Read it")
				assert.strictEqual(view.response?.status, "failed")
				// The Chat tells the client too that a limit stopped the Turn.
				assert.strictEqual(view.response?.error?.code, "limited")
				const record = yield* recordOf(host, receipt.executionId)
				assert.include(record, "BotFeatureStopped")
				assert.include(record, "@openbot-build/plugin-turn-limiter")
				assert.include(record, "ModelStepLimitExceeded")
				assert.match(record, /\["maxSteps",1\]/)
				// The record keeps the history of the Turn, so it can be large.
				assert.isBelow(record.length, 100_000)
				// A limit is not a fault of the server, so a client must not try again at once.
				assert.strictEqual(
					yield* categoryOf(send, receipt.executionId),
					"limited",
				)
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
						id: turnLimiter,
						version: 1,
						settings: { maxSteps: 5 },
						missing: { _tag: "skip" as const },
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

	it.effect(
		"a Turn goes on without a limit plugin that was turned off, also after a host restart in the same process",
		() =>
			Effect.gen(function* () {
				const { host, view } = yield* restartInStep({
					name: "turn-limit-off",
					step: 1,
					before: turnLimit(1),
					after: "- id: turn-limiter\n  disabled: true\n",
				})
				assert.isFalse(
					Arr.some(yield* snapshot(host), (pin) => pin.id === turnLimiter),
				)
				// The pin has a limit of 1 step. Without the plugin the Turn runs
				// all its 3 steps after the restart, and does not wait for the plugin.
				assert.strictEqual(view.response?.status, "completed")
			}).pipe(Effect.scoped),
	)

	it.effect(
		"a Turn waits for a feature that was turned off across a host restart in the same process, and fails after the bound",
		() =>
			Effect.gen(function* () {
				const { host, send, first, view } = yield* restartInStep({
					name: "feature-wait-off",
					step: 1,
					before: "- id: wait-feature\n  disabled: false\n",
					after: "- id: wait-feature\n  disabled: true\n",
					extra: [waitPlugin],
				})
				assert.isFalse(
					Arr.some(yield* snapshot(host), (pin) => pin.id === waitFeature),
				)
				// The pin says `wait`, so the Turn does not go on without the
				// feature. It fails when the bound of 2 seconds is over.
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "internal_error")
				const record = yield* recordOf(host, first.executionId)
				assert.include(record, "BotFeatureMissing")
				assert.include(record, waitFeature)
				assert.strictEqual(
					yield* categoryOf(send, first.executionId),
					"unavailable",
				)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"a Turn keeps its saved step count across a host restart in the same process",
		() =>
			Effect.gen(function* () {
				const { host, send, first, view } = yield* restartInStep({
					name: "turn-limit-steps",
					step: 2,
					before: turnLimit(2),
					after: turnLimit(2),
				})
				// Step 1 ran before the restart, so step 3 is over the limit of 2.
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "limited")
				const record = yield* recordOf(host, first.executionId)
				assert.include(record, "ModelStepLimitExceeded")
				assert.match(record, /\["maxSteps",2\]/)
				assert.strictEqual(
					yield* categoryOf(send, first.executionId),
					"limited",
				)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"a Turn keeps its saved token usage across a host restart in the same process",
		() =>
			Effect.gen(function* () {
				const limit =
					"- id: token-limiter\n  disabled: false\n  config:\n    maxTokens: 3\n"
				const { host, send, first, view } = yield* restartInStep({
					name: "token-limit-usage",
					step: 2,
					before: limit,
					after: limit,
				})
				// Each step uses 2 tokens. Without the 2 tokens of step 1 from before
				// the restart, step 3 would be under the limit of 3.
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "limited")
				const record = yield* recordOf(host, first.executionId)
				assert.include(record, "TokenLimitExceeded")
				assert.match(record, /\["usedTokens",4\]/)
				assert.strictEqual(
					yield* categoryOf(send, first.executionId),
					"limited",
				)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"a Turn keeps the time deadline from its start across a host restart in the same process",
		() =>
			Effect.gen(function* () {
				const maxDuration = 8_000
				const started = yield* Deferred.make<void>()
				// The first request never ends, before and after the restart.
				const model = yield* toolThenAnswer(
					Effect.as(Deferred.succeed(started, undefined), false),
				)
				const publicOrigin = "https://time-limit-restart.example.com"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					pluginsFile: yield* writeFile(
						`- id: time-limiter\n  disabled: false\n  config:\n    maxDuration: ${maxDuration}\n`,
					),
				})
				const { send, bot } = yield* member(
					host,
					publicOrigin,
					"time-limit-restart",
				)
				const begin = yield* Clock.currentTimeMillis
				const first = yield* Messages.message(send, bot, "Wait")
				yield* Deferred.await(started)
				// Restart when more than half of the time is gone.
				yield* Effect.sleep(maxDuration / 2 + 1_000)
				yield* host.restart
				const view = yield* Messages.settled(send, first.chat)
				const end = yield* Clock.currentTimeMillis
				assert.strictEqual(view.response?.id, first.turn)
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(view.response?.error?.code, "limited")
				const record = yield* recordOf(host, first.executionId)
				assert.include(record, "TimeLimitExceeded")
				assert.strictEqual(
					yield* categoryOf(send, first.executionId),
					"limited",
				)
				// A deadline that started again at the restart would end at least
				// 13 seconds after the start of the Turn.
				assert.isBelow(end - begin, maxDuration + 4_000)
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
				const database = yield* TestDatabase.migrated
				const logs = capture()
				const start = (text: string) =>
					Effect.flatMap(writeFile(text), (file) =>
						Layer.build(TestHost.layer({ database, pluginsFile: file })).pipe(
							Effect.provide(logs.layer),
							Effect.scoped,
							Effect.flip,
						),
					)
				const shared = yield* Layer.build(
					PgClient.layer({ url: Redacted.make(database.url) }),
				)
				const failed = (error: Effect.Success<ReturnType<typeof start>>) =>
					Effect.gen(function* () {
						assert.strictEqual(
							error._tag === "StartFailed" ? error.reason : undefined,
							"PluginsInactive",
						)
						const fork = Arr.findFirst(
							error._tag === "StartFailed"
								? TestHost.inactiveForks(error.cause)
								: [],
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
			}).pipe(Effect.scoped),
	)
})
