import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect } from "effect"
import { Artifacts } from "../src/artifacts/Artifacts.ts"
import { Registry, define } from "../src/execution/Engine.ts"
import { Store } from "../src/execution/Store.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"

const origin = "https://artifact-links.example.com"

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"an artifact command saves its child link once with the parent fence",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin: origin })
				const account = yield* host.login("artifact-links")
				const address = yield* host.address
				const send: Messages.Send = (path, method, body) =>
					Caller.withCookie({ address, publicOrigin: origin })(
						account.session,
						path,
						method,
						body,
					)
				const bot = yield* Messages.bot(send)
				const message = yield* Messages.message(send, bot, "Open a Chat")
				yield* Messages.settled(send, message.chat)
				yield* host.run(
					Effect.gen(function* () {
						const store = yield* Store
						const artifacts = yield* Artifacts
						const registry = yield* Registry
						const real = yield* store.locate(
							message.executionId,
							account.identity.organizationId,
						)
						const saved = yield* store.loadMember(real)
						const workflow = define("artifact-link-parent-test")
						yield* registry.register(workflow, (key) =>
							store.loadMember(key).pipe(Effect.asVoid),
						)
						// A stored parent keeps its fence open while the same command is sent again.
						const parent = yield* store.accept(
							real.namespace,
							Execution.CommandKey.make("artifact-link-parent"),
							{ actor: saved.identity.actor, body: null },
							(allocate) =>
								Effect.gen(function* () {
									const key = yield* allocate({
										workflow: workflow._tag,
										identity: saved.identity,
										resource: { kind: "Turn", id: message.turn },
										input: { chat: message.chat },
									})
									return { executionId: key.id, start: false }
								}),
						)
						const key = { namespace: real.namespace, id: parent.executionId }
						const fence = yield* store.takeOver(key)
						const identity = { ...saved.identity, parentExecutionId: fence.id }
						const request = {
							commandKey: Execution.CommandKey.make("artifact-link-file"),
							title: "Plan",
							filename: "plan.txt",
							mediaType: "text/plain",
							from: { _tag: "Text" as const, text: "A fixed plan." },
							citations: [],
							turnId: message.turn,
						}
						const first = yield* artifacts.publishFor(
							identity,
							message.chat,
							request,
							undefined,
							true,
							fence,
						)
						const repeated = yield* artifacts.publishFor(
							identity,
							message.chat,
							request,
							undefined,
							true,
							fence,
						)
						assert.deepStrictEqual(repeated, first)
						const events = yield* store.events(key, 0)
						const links = Arr.filter(
							events,
							(event) => event.body._tag === "ChildExecution",
						)
						assert.strictEqual(links.length, 1)
						assert.deepStrictEqual(links[0]!.body, {
							_tag: "ChildExecution",
							executionId: first.executionId,
							step: "artifact:" + request.commandKey,
						})
						const stale = yield* artifacts
							.publishFor(
								identity,
								message.chat,
								{
									...request,
									commandKey: Execution.CommandKey.make("artifact-link-stale"),
								},
								undefined,
								true,
								{ ...fence, generation: fence.generation - 1 },
							)
							.pipe(Effect.flip)
						assert.ok(stale._tag === "ExecutionConflict")
						assert.strictEqual(
							Arr.filter(
								yield* store.events(key, 0),
								(event) => event.body._tag === "ChildExecution",
							).length,
							1,
						)
					}),
				)
			}),
		30_000,
	)
})
