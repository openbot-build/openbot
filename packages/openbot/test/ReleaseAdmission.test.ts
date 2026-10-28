import { NodeHttpServer } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import {
	HttpClient,
	HttpClientRequest,
	HttpRouter,
	HttpServer,
	HttpServerResponse,
} from "effect/http"
import { SqlClient } from "effect/sql"
import * as Store from "../src/execution/Store.ts"
import * as Release from "../src/release/Admission.ts"
import * as ReleaseHttp from "../src/release/Http.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Fixture from "./ResourceFixture.ts"

const services = Store.layer.pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(Fixture.services),
)
const submission = {
	workflow: "test.accepted-turn",
	resource: { kind: "Turn", id: "turn" },
	identity: {
		owner: { organizationId: "org", userId: "user" },
		actor: { kind: "member", organizationId: "org", userId: "user" },
	},
	input: {},
} satisfies Store.Submission

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"release admission waits for commits, lets accepted work finish, and keeps timers for resume",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const gate = yield* Release.make
				const sql = yield* SqlClient.SqlClient
				const node = yield* Fixture.start()
				yield* Effect.addFinalizer(() =>
					gate.resume.pipe(Effect.orDie, Effect.asVoid),
				)
				const entered = yield* Deferred.make<void>()
				const finish = yield* Deferred.make<void>()
				const command = Execution.CommandKey.make("accepted-before-release")
				const pending = yield* store
					.accept(
						"release",
						command,
						{ actor: submission.identity.actor, body: {} },
						(create) =>
							Effect.gen(function* () {
								yield* Deferred.succeed(entered, undefined)
								yield* Deferred.await(finish)
								return {
									executionId: (yield* create(submission)).id,
									start: true,
								}
							}),
					)
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const closing = yield* gate.quiesce.pipe(Effect.forkScoped)
				yield* Effect.sleep("50 millis")
				assert.isUndefined(yield* Effect.sync(() => closing.pollUnsafe()))
				yield* Deferred.succeed(finish, undefined)
				const receipt = yield* Fiber.join(pending)
				assert.deepEqual(yield* Fiber.join(closing), {
					quiesced: true,
					drained: false,
					activeExecutions: 1,
					activeLeases: 0,
				})
				assert.deepEqual(
					yield* store.accept(
						"release",
						command,
						{ actor: submission.identity.actor, body: {} },
						() => Effect.die("A saved command must not run twice."),
					),
					receipt,
				)
				assert.isTrue(
					Schema.is(Execution.StorageError)(
						yield* store
							.submit(
								"release",
								Execution.CommandKey.make("new-user-work"),
								submission,
							)
							.pipe(Effect.flip),
					),
				)
				const fence = yield* store.takeOver({
					namespace: "release",
					id: receipt.executionId,
				})
				const child = yield* store
					.submit("release", Execution.CommandKey.make("accepted-tool"), {
						...submission,
						ownerExecutionId: receipt.executionId,
						resource: { kind: "ToolCall", id: "tool" },
					})
					.pipe(Effect.provideService(Release.Owner, fence))
				const address = yield* node.directory.prepare({
					namespace: "release",
					kind: "Test",
					id: "tool-resource",
				})
				assert.isTrue(
					Schema.is(Execution.StorageError)(
						yield* node.directory.claim(address, false).pipe(Effect.flip),
					),
				)
				yield* node.directory
					.claim(address, false)
					.pipe(Effect.provideService(Release.Owner, fence))
				assert.deepEqual(yield* gate.status, {
					quiesced: true,
					drained: false,
					activeExecutions: 2,
					activeLeases: 1,
				})
				yield* node.directory.release(address)
				assert.equal(
					(yield* gate.status).activeLeases,
					1,
					"Removing a route does not prove that the resource is closed.",
				)
				yield* node.directory.complete(address, { _tag: "Closed" })
				const childFence = yield* store.takeOver({
					namespace: "release",
					id: child.executionId,
				})
				yield* store.commit(childFence, { status: "completed" }, Effect.void)
				yield* store.commit(fence, { status: "completed" }, Effect.void)
				assert.isTrue((yield* gate.status).drained)
				assert.isTrue(
					Schema.is(Execution.StorageError)(
						yield* store
							.submit(
								"release",
								Execution.CommandKey.make("ended-owner"),
								submission,
							)
							.pipe(Effect.provideService(Release.Owner, fence), Effect.flip),
					),
				)

				yield* gate.resume
				const timer = yield* store.submit(
					"release",
					Execution.CommandKey.make("timer"),
					{
						...submission,
						workflow: "openbot.trigger-schedule",
						resource: { kind: "TriggerSchedule", id: "trigger" },
					},
				)
				const timerFence = yield* store.takeOver({
					namespace: "release",
					id: timer.executionId,
				})
				assert.isTrue(
					(yield* gate.quiesce).drained,
					"An idle timer can stay saved while the service stops.",
				)
				assert.isTrue(
					Schema.is(Execution.StorageError)(
						yield* store
							.submit(
								"release",
								Execution.CommandKey.make("timer-fired"),
								submission,
							)
							.pipe(
								Effect.provideService(Release.Owner, timerFence),
								Effect.flip,
							),
					),
				)
				assert.isFalse(
					Execution.isTerminal((yield* store.get(timerFence)).status),
				)
				const reloaded = yield* Release.make
				assert.isTrue(
					(yield* reloaded.status).quiesced,
					"Another service reads the saved gate.",
				)
				yield* reloaded.resume
				const fired = yield* store
					.submit(
						"release",
						Execution.CommandKey.make("timer-fired"),
						submission,
					)
					.pipe(Effect.provideService(Release.Owner, timerFence))
				const firedFence = yield* store.takeOver({
					namespace: "release",
					id: fired.executionId,
				})
				yield* store.commit(timerFence, { status: "completed" }, Effect.void)
				// Pending decisions and unknown external outcomes must block a release.
				yield* sql`update openbot_executions set status = 'waiting' where id = ${fired.executionId}`
				assert.isFalse((yield* gate.quiesce).drained)
				yield* sql`update openbot_executions set status = 'outcome_unknown' where id = ${fired.executionId}`
				assert.equal((yield* gate.status).activeExecutions, 1)
				yield* sql`update openbot_executions set status = 'running' where id = ${fired.executionId}`
				yield* store.commit(firedFence, { status: "completed" }, Effect.void)
				assert.isTrue((yield* gate.status).drained)
			}),
	)

	it.effect(
		"saved maintenance timers cannot start work or hide an outside call during release",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const gate = yield* Release.make
				const sql = yield* SqlClient.SqlClient
				yield* gate.resume
				yield* Effect.addFinalizer(() =>
					gate.resume.pipe(Effect.orDie, Effect.asVoid),
				)
				for (const [workflow, kind] of [
					["openbot.computer-maintenance", "ComputerMaintenance"],
					["openbot.file-retention", "FileRetention"],
					["openbot.index-watch", "IndexWatch"],
				] as const) {
					const receipt = yield* store.submit(
						"maintenance",
						Execution.CommandKey.make(kind),
						{
							...submission,
							workflow,
							resource: { kind, id: "timer" },
						},
					)
					const owner = yield* store.takeOver({
						namespace: "maintenance",
						id: receipt.executionId,
					})
					assert.isTrue((yield* gate.quiesce).drained)
					assert.isTrue(
						Schema.is(Execution.StorageError)(
							yield* store
								.submit(
									"maintenance",
									Execution.CommandKey.make(kind + "-child"),
									submission,
								)
								.pipe(Effect.provideService(Release.Owner, owner), Effect.flip),
						),
					)
					// Even a timer is not safe to stop if it has an outside call in flight.
					const call = yield* store.intent(owner, {
						step: "outside",
						attempt: 1,
						retry: "never",
						input: {},
					})
					assert.isTrue(
						Schema.is(Execution.StorageError)(
							yield* store.sending(owner, call.id).pipe(Effect.flip),
						),
					)
					assert.equal((yield* store.calls(owner))[0]?.status, "intended")
					yield* gate.resume
					yield* store.sending(owner, call.id)
					assert.isFalse((yield* gate.quiesce).drained)
					yield* sql`update openbot_execution_calls set status = 'outcome_unknown' where id = ${call.id}`
					assert.isFalse((yield* gate.status).drained)
					yield* store.finishCall(owner, call.id, null)
					yield* store.commit(owner, { status: "completed" }, Effect.void)
					assert.isTrue((yield* gate.status).drained)
					yield* gate.resume
				}
			}),
	)

	it.effect(
		"private release HTTP rejects other credentials and new public writes until resume",
		() =>
			Effect.gen(function* () {
				const gate = yield* Release.make
				yield* gate.resume
				yield* Effect.addFinalizer(() =>
					gate.resume.pipe(Effect.orDie, Effect.asVoid),
				)
				const token = "private-release-token-with-at-least-32-characters"
				const protect = yield* ReleaseHttp.middleware
				const testRoutes = Layer.effectDiscard(
					Effect.gen(function* () {
						const router = yield* HttpRouter.HttpRouter
						yield* router.add(
							"POST",
							"/write",
							Effect.succeed(HttpServerResponse.empty({ status: 204 })),
						)
						yield* router.add(
							"GET",
							"/read",
							Effect.succeed(HttpServerResponse.empty({ status: 204 })),
						)
					}),
				)
				const server = yield* Layer.build(
					HttpRouter.serve(
						Layer.merge(testRoutes, ReleaseHttp.routes(Redacted.make(token))),
						{
							middleware: protect,
							disableLogger: true,
							disableListenLog: true,
						},
					).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
				)
				const address = Context.get(server, HttpServer.HttpServer).address
				if (address._tag === "UnixPathAddress")
					return yield* Effect.die("This test needs TCP.")
				const base = `http://127.0.0.1:${address.port}`
				const client = yield* HttpClient.HttpClient
				const call = (name: string, authorization = `Bearer ${token}`) =>
					client.execute(
						HttpClientRequest.post(base + ReleaseHttp.path + "/" + name, {
							headers: { authorization },
						}),
					)
				assert.equal((yield* call("quiesce", "Bearer other-token")).status, 401)
				assert.isFalse((yield* gate.status).quiesced)
				assert.equal((yield* call("quiesce")).status, 200)
				assert.equal((yield* client.post(base + "/write")).status, 503)
				assert.equal((yield* client.get(base + "/read")).status, 204)
				const status = yield* Schema.decodeUnknownEffect(Release.Status)(
					yield* (yield* call("status")).json,
				)
				assert.isTrue(status.quiesced)
				assert.isTrue(status.drained)
				assert.equal((yield* call("resume")).status, 200)
				assert.equal((yield* client.post(base + "/write")).status, 204)
			}),
	)
})
