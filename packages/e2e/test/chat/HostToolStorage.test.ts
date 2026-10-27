import { assert, it } from "@effect/vitest"
import { HostTools } from "@openbot-build/openbot"
import { BrowserHost, Caller, Messages } from "@openbot-build/openbot/testing"
import { Context, Deferred, Effect, Layer, Ref, Stream } from "effect"
import { LanguageModel, Response } from "effect/ai"

class ResidentConfiguration extends Context.Service<
	ResidentConfiguration,
	number
>()(
	"@openbot-build/e2e/test/chat/HostToolStorage.test/ResidentConfiguration",
) {}

const model = Layer.effect(
	LanguageModel.LanguageModel,
	LanguageModel.make({
		generateText: () => Effect.succeed([]),
		streamText: () =>
			Stream.make(
				Response.makePart("finish", {
					reason: "stop",
					usage: Response.Usage.make({
						inputTokens: { total: 1 },
						outputTokens: { total: 1 },
					}),
				}),
			),
	}),
)

/** One set of services serves all the steps of a test, like one running server. */
const residentServices = BrowserHost.layerPlatform.pipe(
	Layer.provideMerge(model),
	Layer.provideMerge(Layer.succeed(ResidentConfiguration, 7)),
)

/**
 * A host plugin with resources for each Turn. It counts
 * its builds, its open resources and its Turns. A failing one also has a part
 * whose build fails.
 */
const residentTools = (
	counters: {
		readonly builds: Ref.Ref<number>
		readonly active: Ref.Ref<number>
		readonly turns: Ref.Ref<number>
	},
	options: { readonly fail: boolean },
) =>
	Layer.effect(
		HostTools.HostTools,
		Effect.map(ResidentConfiguration, (configuration) =>
			HostTools.HostTools.of({
				register: Effect.gen(function* () {
					assert.strictEqual(configuration, 7)
					yield* Ref.update(counters.builds, (n) => n + 1)
					const ready = yield* Deferred.make<void>()
					yield* Effect.forkScoped(
						Effect.acquireRelease(
							Ref.update(counters.active, (n) => n + 1),
							() => Ref.update(counters.active, (n) => n - 1),
						).pipe(
							Effect.andThen(Deferred.succeed(ready, undefined)),
							Effect.andThen(Effect.never),
						),
					)
					yield* Deferred.await(ready)
					if (options.fail) return yield* Effect.die("construction-failed")
					assert.strictEqual(yield* Ref.get(counters.active), 1)
					yield* Ref.update(counters.turns, (n) => n + 1)
					return { tools: {}, handlers: Context.empty() }
				}),
			}),
		),
	)

it.layer(residentServices, { excludeTestServices: true })((it) => {
	it.effect(
		"OpenBot registers host tools for each Turn and releases it when the Turn ends",
		() =>
			Effect.gen(function* () {
				const counters = {
					builds: yield* Ref.make(0),
					active: yield* Ref.make(0),
					turns: yield* Ref.make(0),
				}
				const { builds, active, turns } = counters
				const answers = yield* LanguageModel.LanguageModel
				const configuration = Layer.succeed(ResidentConfiguration, 7)
				for (const fail of [false, true]) {
					const publicOrigin = fail
						? "https://failed-tools.example.com"
						: "https://resident-tools.example.com"
					const tools = residentTools(counters, { fail }).pipe(
						Layer.provide(configuration),
					)
					const host = yield* BrowserHost.start({
						publicOrigin,
						model: answers,
						hostTools: tools,
					})
					const member = yield* host.login(
						fail ? "failed-tools" : "resident-tools",
					)
					const bot = yield* host.defaultBot(member.session)
					const send: Messages.Send = (path, method, body) =>
						Effect.flatMap(host.address, (address) =>
							Caller.withCookie({ address, publicOrigin })(
								member.session,
								path,
								method,
								body,
							),
						)
					const before = yield* Ref.get(builds)
					assert.strictEqual(yield* Ref.get(active), 0)
					for (const index of [1, 2]) {
						const { view } = yield* Messages.talk(send, bot, "go")
						assert.strictEqual(view.status, fail ? "Failed" : "Completed")
						assert.strictEqual(yield* Ref.get(builds), before + index)
						assert.strictEqual(yield* Ref.get(active), 0)
					}
				}
				assert.strictEqual(yield* Ref.get(turns), 2)
			}),
		60000,
	)
})
