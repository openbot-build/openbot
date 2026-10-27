import { App } from "@openbot-build/protocol"
import * as ConnectionScopes from "../src/resources/ConnectionScopes.ts"
import { RunnerAddress, RunnerStorage } from "effect/cluster"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Authorization, type ExecutionIdentity } from "@openbot-build/domain"
import { Socket } from "effect/socket"
import { Base64 } from "effect/encoding"
import * as Connector from "../src/computers/connector/Connectors.ts"
import { Bots } from "../src/bots/Bots.ts"
import * as Db from "../src/database/Database.ts"
import { computers as computerRows } from "../src/database/Schema.ts"
import { TestClock } from "effect/testing"
import * as ProcessSink from "../src/computers/Process.ts"
import * as Sessions from "../src/computers/Sessions.ts"
import { Computers } from "../src/computers/Computers.ts"
import { Machine } from "../src/computers/Computer.ts"
import * as Send from "../src/execution/Send.ts"
import { Computers as ComputersApi } from "@openbot-build/domain"
import { Execution, TokenId } from "@openbot-build/domain"
import { SqlClient, SqlError } from "effect/sql"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Cause,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Queue,
	Schema,
	Scope,
	Stream,
} from "effect"
import { HttpClient } from "effect/http"
import * as Records from "../src/errors/Records.ts"
import * as Directory from "../src/resources/Directory.ts"
import * as Resource from "../src/resources/Resource.ts"
import * as Transport from "../src/resources/Transport.ts"

import { services, start } from "./ResourceFixture.ts"

const testActor = {
	kind: "member",
	organizationId: "session-org",
	userId: "member",
} as const
const sessionOwner = {
	identity: { owner: testActor, actor: testActor },
	computer: "computer",
}
const computer: ComputersApi.Computer = {
	id: ComputersApi.ComputerId.make("computer"),
	name: "Test",
	owner: { _tag: "Member", userId: testActor.userId },
	source: { _tag: "Connector" },
	state: "running",
	features: { desktop: false, ports: false, pause: false },
	createdBy: testActor.userId,
	version: 1,
	pauseAfter: null,
	createdAt: 0,
	updatedAt: 0,
	lastActiveAt: null,
}
const directAccess = Layer.mock(Send.Access, {
	resolve: (authority) =>
		authority._tag === "Request"
			? Effect.succeed(authority.identity)
			: Effect.die("This test uses a direct request."),
})
const sessionAt = (
	transport: Transport.Transport["Service"],
	permissions = Layer.mock(Computers, {
		get: () => Effect.succeed(computer),
		holds: () => Effect.succeed(true),
	}),
) =>
	Layer.build(
		Sessions.layer.pipe(
			Layer.provide([
				Layer.succeed(Transport.Transport, transport),
				permissions,
				directAccess,
			]),
		),
	).pipe(Effect.map((context) => Context.get(context, Sessions.Sessions)))
const command = Effect.gen(function* () {
	const sink = yield* ProcessSink.make
	const closed = yield* Deferred.make<void>()
	const machine = new Machine({
		shell: {
			start: () =>
				Effect.acquireRelease(
					Effect.succeed({
						output: sink.output,
						exit: sink.exit,
						write: sink.push,
						resize: () => Effect.void,
						signal: () => sink.end({ code: 0, signal: null }),
					}),
					() =>
						Deferred.succeed(closed, undefined).pipe(
							Effect.andThen(sink.end({ code: 0, signal: null })),
						),
				),
			read: () => Effect.die("No file read is expected."),
			write: () => Effect.die("No file write is expected."),
			list: () => Effect.die("No file list is expected."),
			remove: () => Effect.die("No file removal is expected."),
		},
		state: Effect.succeed("running"),
		destroy: Effect.void,
	})
	return { machine, sink, closed }
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	for (const remote of [false, true]) {
		it.effect(
			`resource release waits for physical close on ${remote ? "another" : "this"} node`,
			() =>
				Effect.gen(function* () {
					const owner = yield* start()
					const client = remote ? yield* start() : owner
					const ref = {
						namespace: "release",
						kind: "socket",
						id: remote ? "remote" : "local",
					}
					const ready = yield* Deferred.make<void>()
					const closing = yield* Deferred.make<void>()
					const gate = yield* Deferred.make<void>()
					const physical = yield* owner.transport
						.own(
							ref,
							() => Stream.empty,
							{ admit: Effect.void },
							() =>
								Effect.gen(function* () {
									yield* Effect.addFinalizer(() =>
										Deferred.succeed(closing, undefined).pipe(
											Effect.andThen(Deferred.await(gate)),
										),
									)
									yield* Deferred.succeed(ready, undefined)
									return yield* Effect.never
								}),
						)
						.pipe(Effect.forkChild)
					yield* Deferred.await(ready)
					const done = yield* Deferred.make<void>()
					const release = yield* client.transport.release(ref).pipe(
						Effect.tap(() => Deferred.succeed(done, undefined)),
						Effect.forkChild,
					)
					yield* Effect.gen(function* () {
						yield* Deferred.await(closing)
						assert.isFalse(yield* Deferred.isDone(done))
						assert.isTrue(Option.isSome(yield* owner.directory.find(ref)))
						yield* Deferred.succeed(gate, undefined)
						yield* Fiber.join(release)
						yield* Fiber.await(physical)
						assert.isTrue(Option.isNone(yield* owner.directory.find(ref)))
						// A later request uses the saved result after the owner and its route are gone.
						yield* client.transport.release(ref)
					}).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
				}),
		)
		it.effect(
			`resource close failure is kept on ${remote ? "another" : "this"} node`,
			() =>
				Effect.gen(function* () {
					const owner = yield* start()
					const client = remote ? yield* start() : owner
					const ref = {
						namespace: "release-failure",
						kind: "socket",
						id: remote ? "remote" : "local",
					}
					const ready = yield* Deferred.make<void>()
					const physical = yield* owner.transport
						.own(
							ref,
							() => Stream.empty,
							{ admit: Effect.void },
							() =>
								Effect.gen(function* () {
									yield* Effect.addFinalizer(() =>
										Effect.die("The socket did not close"),
									)
									yield* Deferred.succeed(ready, undefined)
									return yield* Effect.never
								}),
						)
						.pipe(Effect.forkChild)
					yield* Deferred.await(ready)
					const result = yield* Effect.exit(client.transport.release(ref))
					assert.isTrue(Exit.isFailure(result))
					if (Exit.isSuccess(result))
						return assert.fail("Expected a saved close failure")
					assert.ok(
						Arr.some(
							result.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(Resource.Failed)(reason.error),
						),
					)
					yield* Fiber.await(physical)
					const again = yield* Effect.exit(client.transport.release(ref))
					assert.isTrue(Exit.isFailure(again))
					if (Exit.isFailure(again))
						assert.deepStrictEqual(again.cause.reasons, result.cause.reasons)
					if (remote) {
						yield* owner.close
						const afterStop = yield* Effect.exit(client.transport.release(ref))
						assert.isTrue(Exit.isFailure(afterStop))
						if (Exit.isFailure(afterStop))
							assert.deepStrictEqual(
								afterStop.cause.reasons,
								result.cause.reasons,
							)
					}
				}),
		)
	}

	it.effect(
		"a lost release reply reads the saved close result without sending again",
		() =>
			Effect.gen(function* () {
				const owner = yield* start()
				const http = yield* HttpClient.HttpClient
				const replies = yield* Ref.make(0)
				const client = yield* start({
					http: HttpClient.transformResponse(
						http,
						Effect.flatMap((response) =>
							response.text.pipe(
								Effect.andThen(Ref.update(replies, (n) => n + 1)),
								Effect.andThen(Effect.die("The reply was lost.")),
							),
						),
					),
				})
				const ref = { namespace: "lost-reply", kind: "socket", id: "one" }
				const ready = yield* Deferred.make<void>()
				const closes = yield* Ref.make(0)
				const physical = yield* owner.transport
					.own(
						ref,
						() => Stream.empty,
						{ admit: Effect.void },
						() =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() =>
									Ref.update(closes, (n) => n + 1),
								)
								yield* Deferred.succeed(ready, undefined)
								return yield* Effect.never
							}),
					)
					.pipe(Effect.forkChild)
				yield* Deferred.await(ready)
				yield* client.transport.release(ref)
				yield* Fiber.await(physical)
				assert.equal(yield* Ref.get(closes), 1)
				assert.equal(yield* Ref.get(replies), 1)
				yield* client.transport.release(ref)
				assert.equal(yield* Ref.get(replies), 1)
			}),
	)

	it.effect("a known physical close survives a failed result save", () =>
		Effect.gen(function* () {
			const failOnce = yield* Ref.make(true)
			const owner = yield* start({
				directory: (directory) => ({
					...directory,
					complete: (address, result) =>
						Ref.getAndSet(failOnce, false).pipe(
							Effect.flatMap((fail) =>
								fail
									? Effect.fail(
											Execution.StorageError.make({
												cause: Cause.fail(
													"The close result could not be saved.",
												),
											}),
										)
									: directory.complete(address, result),
							),
						),
				}),
			})
			const client = yield* start()
			const ready = yield* Deferred.make<void>()
			const closes = yield* Ref.make(0)
			const ref = { namespace: "save-failure", kind: "socket", id: "one" }
			const physical = yield* owner.transport
				.own(
					ref,
					() => Stream.empty,
					{ admit: Effect.void },
					() =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Ref.update(closes, (n) => n + 1))
							yield* Deferred.succeed(ready, undefined)
							return yield* Effect.never
						}),
				)
				.pipe(Effect.forkChild)
			yield* Deferred.await(ready)
			assert.isTrue(
				Exit.isFailure(yield* Effect.exit(client.transport.release(ref))),
			)
			yield* Fiber.await(physical)
			assert.isTrue(Option.isNone(yield* owner.directory.find(ref)))
			yield* client.transport.release(ref)
			assert.equal(yield* Ref.get(closes), 1)
			yield* owner.close
			yield* client.transport.release(ref)
		}),
	)

	it.effect(
		"an unreachable owner has an unknown close result even after its route is gone",
		() =>
			Effect.gen(function* () {
				const owner = yield* start()
				const client = yield* start()
				const ref = { namespace: "lost-owner", kind: "socket", id: "one" }
				const address = yield* owner.directory.prepare(ref)
				yield* owner.directory.claim(address, false)
				yield* owner.close
				assert.isTrue(Option.isNone(yield* client.directory.find(ref)))
				const failure = yield* client.transport.release(ref).pipe(Effect.flip)
				assert.ok(Schema.is(Resource.Failed)(failure))
				if (Schema.is(Resource.Failed)(failure))
					assert.equal(failure.outcome, "unknown")
			}),
	)

	it.effect("a replaced lease closes even when the close signal was lost", () =>
		Effect.gen(function* () {
			const owner = yield* start()
			const remote = yield* start()
			const ref = { namespace: "lost-signal", kind: "socket", id: "one" }
			const ready = yield* Deferred.make<void>()
			const closed = yield* Deferred.make<void>()
			const physical = yield* owner.transport
				.own(
					ref,
					() => Stream.empty,
					{ admit: Effect.void },
					() =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Deferred.succeed(closed, undefined),
							)
							yield* Deferred.succeed(ready, undefined)
							return yield* Effect.never
						}),
				)
				.pipe(Effect.forkChild)
			yield* Deferred.await(ready)
			// Change the durable lease without a Close RPC to the old process.
			const next = yield* remote.directory.prepare(ref)
			yield* remote.directory.claim(next, true)
			yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))
			yield* Fiber.await(physical)
			assert.equal(
				Option.getOrThrow(yield* remote.directory.find(ref)).lease,
				next.lease,
			)
		}),
	)

	it.effect("App cleanup closes every physical scope across nodes", () =>
		Effect.gen(function* () {
			const first = yield* start()
			const second = yield* start()
			const at = (node: typeof first) =>
				Layer.build(
					ConnectionScopes.layer.pipe(
						Layer.provide(Layer.succeed(Transport.Transport, node.transport)),
					),
				).pipe(
					Effect.map((context) => Context.get(context, App.ConnectionScopes)),
				)
			const a = yield* at(first)
			const b = yield* at(second)
			const gate = yield* Deferred.make<void>()
			const closing = yield* Ref.make(0)
			const both = yield* Deferred.make<void>()
			const key = { owner: "app-owner", connectionId: "many" }
			for (const scopes of [a, b]) {
				const scope = yield* Scope.make()
				yield* Scope.addFinalizer(
					scope,
					Ref.updateAndGet(closing, (n) => n + 1).pipe(
						Effect.tap((n) =>
							n === 2 ? Deferred.succeed(both, undefined) : Effect.void,
						),
						Effect.andThen(Deferred.await(gate)),
					),
				)
				const { close } = yield* scopes.register({ key, scope })
				yield* Effect.addFinalizer(() => close)
			}
			const done = yield* Deferred.make<void>()
			const stopped = yield* b.close(key).pipe(
				Effect.tap(() => Deferred.succeed(done, undefined)),
				Effect.forkChild,
			)
			yield* Effect.gen(function* () {
				yield* Deferred.await(both).pipe(Effect.timeout("5 seconds"))
				assert.isFalse(yield* Deferred.isDone(done))
				yield* Deferred.succeed(gate, undefined)
				yield* Fiber.join(stopped)
				yield* a.close(key)
				assert.equal(yield* Ref.get(closing), 2)
			}).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
		}),
	)

	it.effect("a caller close failure remains visible to App cleanup", () =>
		Effect.gen(function* () {
			const owner = yield* start()
			const remote = yield* start()
			const at = (node: typeof owner) =>
				Layer.build(
					ConnectionScopes.layer.pipe(
						Layer.provide(Layer.succeed(Transport.Transport, node.transport)),
					),
				).pipe(
					Effect.map((context) => Context.get(context, App.ConnectionScopes)),
				)
			const local = yield* at(owner)
			const other = yield* at(remote)
			const scope = yield* Scope.make()
			yield* Scope.addFinalizer(
				scope,
				Effect.die("The App socket did not close."),
			)
			const key = { owner: "app-owner", connectionId: "failed" }
			const { close } = yield* local.register({ key, scope })
			const caller = yield* Effect.exit(close)
			assert.isTrue(Exit.isFailure(caller))
			const first = yield* Effect.exit(other.close(key))
			assert.isTrue(Exit.isFailure(first))
			yield* owner.close
			const callerAgain = yield* Effect.exit(close)
			assert.isTrue(Exit.isFailure(callerAgain))
			if (Exit.isFailure(caller) && Exit.isFailure(callerAgain))
				assert.deepStrictEqual(callerAgain.cause.reasons, caller.cause.reasons)
			const again = yield* Effect.exit(other.close(key))
			assert.isTrue(Exit.isFailure(again))
			if (Exit.isFailure(first) && Exit.isFailure(again))
				assert.deepStrictEqual(again.cause.reasons, first.cause.reasons)
		}),
	)

	it.effect("an unhealthy runner must still confirm physical close", () =>
		Effect.gen(function* () {
			const owner = yield* start()
			const client = yield* start()
			const ready = yield* Deferred.make<Resource.Address>()
			const closing = yield* Deferred.make<void>()
			const gate = yield* Deferred.make<void>()
			const ref = { namespace: "health", kind: "socket", id: "one" }
			const physical = yield* owner.transport
				.own(
					ref,
					() => Stream.empty,
					{ admit: Effect.void },
					(held) =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Deferred.succeed(closing, undefined).pipe(
									Effect.andThen(Deferred.await(gate)),
								),
							)
							yield* Deferred.succeed(ready, held.address)
							return yield* Effect.never
						}),
				)
				.pipe(Effect.forkChild)
			const address = yield* Deferred.await(ready)
			const runners = yield* RunnerStorage.RunnerStorage
			yield* runners.setRunnerHealth(
				RunnerAddress.make(address.host, address.port),
				false,
			)
			assert.isTrue(Option.isNone(yield* client.directory.find(ref)))
			const done = yield* Deferred.make<void>()
			const release = yield* client.transport.release(ref).pipe(
				Effect.tap(() => Deferred.succeed(done, undefined)),
				Effect.forkChild,
			)
			yield* Effect.gen(function* () {
				yield* Deferred.await(closing).pipe(Effect.timeout("5 seconds"))
				assert.isFalse(yield* Deferred.isDone(done))
				yield* Deferred.succeed(gate, undefined)
				yield* Fiber.join(release)
				yield* Fiber.await(physical)
			}).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
		}),
	)

	it.effect(
		"resource waiters share a reader and wait for a new lease after a lost handler",
		() =>
			Effect.gen(function* () {
				const owner = yield* start()
				const remote = yield* start()
				const ref = { namespace: "wait-test", kind: "physical", id: "one" }
				const first = yield* remote.directory.wait(ref).pipe(Effect.forkScoped)
				const second = yield* remote.directory.wait(ref).pipe(Effect.forkScoped)
				const initial = yield* owner.directory.prepare(ref)
				yield* owner.directory.claim(initial, false)
				assert.strictEqual((yield* Fiber.join(first)).lease, initial.lease)
				assert.strictEqual((yield* Fiber.join(second)).lease, initial.lease)
				// An old directory row must not make a missing handler spin in a retry loop.
				const next = yield* remote.directory
					.wait(ref, initial.lease)
					.pipe(Effect.forkScoped)
				const stopped = yield* remote.directory
					.wait(ref, initial.lease)
					.pipe(Effect.forkScoped)
				yield* Fiber.interrupt(stopped)
				const replacement = yield* owner.directory.prepare(ref)
				yield* owner.directory.claim(replacement, true)
				assert.strictEqual((yield* Fiber.join(next)).lease, replacement.lease)
			}).pipe(Effect.timeout("5 seconds")),
	)

	it.effect(
		"a nested session send keeps the new request authority and its safe failure",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const second = yield* start()
				const local = yield* sessionAt(first.transport)
				const remote = yield* sessionAt(second.transport)
				const process = yield* command
				const seen = yield* Ref.make(Option.none<Send.Authority>())
				const failure: Execution.Failure = {
					category: "forbidden",
					errorId: Execution.ErrorId.make("permission-changed"),
				}
				const machine = new Machine({
					...process.machine,
					shell: {
						...process.machine.shell,
						start: (request) =>
							process.machine.shell.start(request).pipe(
								Effect.map((process) => ({
									...process,
									write: () =>
										Send.authority(sessionOwner.identity).pipe(
											Effect.flatMap((authority) =>
												Ref.set(seen, Option.some(authority)),
											),
											Effect.andThen(Effect.fail(failure)),
										),
								})),
							),
					},
				})
				const started = yield* local.exec({
					owner: sessionOwner,
					machine,
					request: { command: "cat", yieldTimeMs: 1 },
				})
				assert.ok(started.session !== null)
				if (started.session === null) return
				const identity: ExecutionIdentity = {
					...sessionOwner.identity,
					constraints: [
						{
							...testActor,
							kind: "user_token",
							tokenId: TokenId.make("new-limit"),
						},
					],
				}
				const error = yield* remote
					.write({ ...sessionOwner, identity }, started.session, {
						chars: "input",
					})
					.pipe(Effect.flip)
				assert.deepStrictEqual(error, failure)
				assert.deepStrictEqual(
					yield* Ref.get(seen),
					Option.some(Send.Authority.cases.Request.make({ identity })),
				)
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)
	it.effect(
		"an unknown process exit cannot become a successful session result",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const local = yield* sessionAt(first.transport)
				const process = yield* command
				const failure: Execution.Failure = {
					category: "outcome_unknown",
					errorId: Execution.ErrorId.make("process-lost"),
				}
				yield* process.sink.end({ code: null, signal: null, failure })
				const error = yield* local
					.exec({
						owner: sessionOwner,
						machine: process.machine,
						request: { command: "cat", yieldTimeMs: 250 },
					})
					.pipe(Effect.flip)
				assert.deepStrictEqual(error, failure)
				assert.isTrue(yield* Deferred.isDone(process.closed))
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	it.effect(
		"a directory cleanup failure keeps the final command reply",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const second = yield* start()
				const broken = Transport.Transport.of({
					...first.transport,
					register: (...args) =>
						first.transport.register(...args).pipe(
							Effect.map((held) => ({
								...held,
								retire: held.retire.pipe(
									Effect.andThen(
										Effect.fail(
											Execution.StorageError.make({
												cause: Cause.fail("The cleanup failed."),
											}),
										),
									),
								),
							})),
						),
				})
				const local = yield* sessionAt(broken)
				const remote = yield* sessionAt(second.transport)
				const process = yield* command
				const initial = yield* local.exec({
					owner: sessionOwner,
					machine: process.machine,
					request: { command: "cat", yieldTimeMs: 1 },
				})
				assert.ok(initial.session !== null)
				if (initial.session === null) return
				yield* process.sink.push(new TextEncoder().encode("last"))
				yield* process.sink.end({ code: 0, signal: null })
				const reply = yield* remote.write(sessionOwner, initial.session, {
					chars: "",
					yieldTimeMs: 250,
				})
				assert.deepEqual(reply, {
					session: null,
					running: false,
					exitCode: 0,
					signal: null,
					output: "last",
					truncated: false,
				})
				assert.isTrue(yield* Deferred.isDone(process.closed))
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	it.effect(
		"a blocked session write does not stop idle process cleanup",
		() =>
			Effect.gen(function* () {
				const node = yield* start()
				const sessions = yield* sessionAt(node.transport)
				const first = yield* command
				const second = yield* command
				const writing = yield* Deferred.make<void>()
				const blocked = new Machine({
					...first.machine,
					shell: {
						...first.machine.shell,
						start: (request) =>
							first.machine.shell.start(request).pipe(
								Effect.map((process) => ({
									...process,
									write: () =>
										Deferred.succeed(writing, undefined).pipe(
											Effect.andThen(Effect.never),
										),
								})),
							),
					},
				})
				const firstReply = yield* sessions.exec({
					owner: sessionOwner,
					machine: blocked,
					request: { command: "one", yieldTimeMs: 0 },
				})
				const secondReply = yield* sessions.exec({
					owner: sessionOwner,
					machine: second.machine,
					request: { command: "two", yieldTimeMs: 0 },
				})
				assert.ok(firstReply.session !== null && secondReply.session !== null)
				if (firstReply.session === null) return
				const pending = yield* sessions
					.write(sessionOwner, firstReply.session, {
						chars: "wait",
						yieldTimeMs: 250,
					})
					.pipe(Effect.forkScoped)
				yield* Deferred.await(writing)
				yield* TestClock.adjust("31 minutes")
				yield* Deferred.await(first.closed)
				yield* Deferred.await(second.closed)
				const error = yield* Fiber.join(pending).pipe(Effect.flip)
				assert.ok(Schema.is(Execution.Failure)(error))
				if (Schema.is(Execution.Failure)(error))
					assert.equal(error.category, "outcome_unknown")
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		{ timeout: 60000 },
	)

	it.effect(
		"a directory cleanup failure does not drop a command end notice",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const broken = Transport.Transport.of({
					...first.transport,
					register: (...args) =>
						first.transport.register(...args).pipe(
							Effect.map((held) => ({
								...held,
								retire: held.retire.pipe(
									Effect.andThen(
										Effect.fail(
											Execution.StorageError.make({
												cause: Cause.fail("The cleanup failed."),
											}),
										),
									),
								),
							})),
						),
				})
				const sessions = yield* sessionAt(broken)
				const process = yield* command
				const notice = yield* Deferred.make<string>()
				const initial = yield* sessions.exec({
					owner: sessionOwner,
					machine: process.machine,
					request: { command: "cat", yieldTimeMs: 1 },
					onEnd: (_, text) =>
						Deferred.succeed(notice, text).pipe(Effect.asVoid),
				})
				assert.isTrue(initial.running)
				yield* process.sink.push(new TextEncoder().encode("done"))
				yield* process.sink.end({ code: 0, signal: null })
				assert.equal(yield* Deferred.await(notice), "done")
				assert.isTrue(yield* Deferred.isDone(process.closed))
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	it.effect(
		"command sessions use the owner node and keep their last reply",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const second = yield* start()
				const allowed = yield* Ref.make(true)
				const writes = yield* Ref.make<ReadonlyArray<string>>([])
				const checked = yield* Ref.make<ReadonlyArray<string>>([])
				const ended = yield* Deferred.make<{
					readonly code: number
					readonly signal: null
				}>()
				const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
				const permission = Layer.mock(Computers, {
					get: (caller, id, mode) =>
						Ref.update(checked, (all) => [
							...all,
							`${caller.kind}:${mode}`,
						]).pipe(
							Effect.andThen(
								caller.kind === "member"
									? Effect.succeed(true)
									: Ref.get(allowed),
							),
							Effect.flatMap((yes) =>
								yes
									? Effect.succeed({
											id: ComputersApi.ComputerId.make(id),
											name: "Test",
											owner: { _tag: "Member" as const, userId: caller.userId },
											source: { _tag: "Connector" as const },
											state: "running" as const,
											features: { desktop: false, ports: false, pause: false },
											createdBy: caller.userId,
											version: 1,
											pauseAfter: null,
											createdAt: 0,
											updatedAt: 0,
											lastActiveAt: null,
										})
									: Effect.fail(ComputersApi.ComputerNotFound.make({ id })),
							),
						),
					holds: () => Effect.succeed(true),
				})
				const send = Layer.mock(Send.Access, {
					resolve: (authority) =>
						authority._tag === "Request"
							? Effect.succeed(authority.identity)
							: Effect.die("This test uses a direct request."),
				})
				const at = (node: typeof first) =>
					Layer.build(
						Sessions.layer.pipe(
							Layer.provide([
								Layer.succeed(Transport.Transport, node.transport),
								permission,
								send,
							]),
						),
					).pipe(
						Effect.map((context) => Context.get(context, Sessions.Sessions)),
					)
				const local = yield* at(first)
				const remote = yield* at(second)
				const process = {
					output: Stream.fromQueue(output),
					exit: Deferred.await(ended),
					write: (bytes: Uint8Array) =>
						Ref.update(writes, (all) => [
							...all,
							new TextDecoder().decode(bytes),
						]).pipe(Effect.andThen(Queue.offer(output, bytes)), Effect.asVoid),
					resize: () => Effect.void,
					signal: () =>
						Queue.end(output).pipe(
							Effect.andThen(
								Deferred.succeed(ended, { code: 0, signal: null }),
							),
							Effect.asVoid,
						),
				}
				const machine = new Machine({
					shell: {
						start: () =>
							Effect.acquireRelease(Effect.succeed(process), () =>
								Queue.end(output),
							),
						read: () => Effect.die("No file read is expected."),
						write: () => Effect.die("No file write is expected."),
						list: () => Effect.die("No file list is expected."),
						remove: () => Effect.die("No file removal is expected."),
					},
					state: Effect.succeed("running"),
					destroy: Effect.void,
				})
				const actor = {
					kind: "member",
					organizationId: "session-org",
					userId: "member",
				} as const
				const owner = {
					identity: {
						owner: actor,
						actor,
						constraints: [
							{
								...actor,
								kind: "user_token" as const,
								tokenId: TokenId.make("limited"),
							},
						],
					},
					computer: "computer",
				}
				const initial = yield* local.exec({
					owner,
					machine,
					request: { command: "cat", yieldTimeMs: 250 },
				})
				assert.ok(initial.session !== null)
				if (initial.session === null) return
				const id = initial.session
				const reply = yield* remote.write(owner, id, {
					chars: "one",
					yieldTimeMs: 250,
				})
				assert.equal(reply.output, "one")
				const other = {
					...owner,
					identity: {
						owner: { ...actor, userId: "other" },
						actor: { ...actor, userId: "other" },
					},
				}
				assert.ok(
					Schema.is(Sessions.SessionGone)(
						yield* remote
							.write(other, id, { chars: "other", yieldTimeMs: 250 })
							.pipe(Effect.flip),
					),
				)
				yield* Ref.set(allowed, false)
				yield* remote
					.write(owner, id, { chars: "denied", yieldTimeMs: 250 })
					.pipe(Effect.flip)
				assert.deepEqual(yield* Ref.get(writes), ["one"])
				yield* Ref.set(allowed, true)
				const last = yield* remote.close(owner, id)
				assert.isFalse(last.running)
				assert.equal(last.exitCode, 0)
				assert.ok(
					Schema.is(Sessions.SessionGone)(
						yield* remote
							.write(owner, id, { chars: "late", yieldTimeMs: 250 })
							.pipe(Effect.flip),
					),
				)
				assert.deepEqual(yield* Ref.get(checked), [
					"member:use",
					"user_token:use",
					"member:use",
					"user_token:use",
					"member:use",
					"user_token:use",
					"member:use",
					"user_token:use",
				])
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	for (const physicalLoss of [false, true])
		it.effect(
			`retired calls keep their final reply unless the connection is lost: ${physicalLoss}`,
			() =>
				Effect.gen(function* () {
					const first = yield* start()
					const second = yield* start()
					const entered = yield* Deferred.make<void>()
					const retired = yield* Deferred.make<void>()
					const finish = yield* Deferred.make<void>()
					const resource = {
						namespace: "member",
						kind: "test",
						id: `retire-${physicalLoss}`,
					}
					const retirement =
						yield* Deferred.make<Effect.Effect<void, Execution.StorageError>>()
					const held = yield* first.transport.register(resource, () =>
						Stream.fromEffect(
							Effect.gen(function* () {
								yield* Deferred.succeed(entered, undefined)
								yield* yield* Deferred.await(retirement)
								yield* Deferred.succeed(retired, undefined)
								yield* Deferred.await(finish)
								return "last reply"
							}),
						),
					)
					yield* Deferred.succeed(retirement, held.retire)
					const running = yield* second.transport
						.call(resource, null)
						.pipe(Stream.runCollect, Effect.forkScoped)
					yield* Deferred.await(entered)
					yield* Deferred.await(retired)
					assert.isTrue(Option.isNone(yield* first.directory.find(resource)))
					assert.isFalse(yield* first.transport.exists(held.address))
					assert.ok(
						Schema.is(Resource.Gone)(
							yield* second.transport
								.callAt(held.address, null)
								.pipe(Stream.runDrain, Effect.flip),
						),
					)
					if (physicalLoss) {
						yield* first.transport.closeLocal(held.address)
						const error = yield* Fiber.join(running).pipe(Effect.flip)
						assert.ok(Schema.is(Resource.Failed)(error))
						if (Schema.is(Resource.Failed)(error))
							assert.equal(error.outcome, "unknown")
					} else {
						yield* Deferred.succeed(finish, undefined)
						assert.deepEqual(yield* Fiber.join(running), ["last reply"])
					}
					yield* held.lost
				}).pipe(Effect.scoped),
			{ timeout: 60000 },
		)

	it.effect(
		"a lost connection closes its handler before waiting for the error store",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const released = yield* Deferred.make<void>()
				const recording = yield* Deferred.make<void>()
				const allowRecord = yield* Deferred.make<void>()
				const real = yield* Records.Records
				const first = yield* start({
					errors: Records.Records.of({
						record: (...args) =>
							Deferred.succeed(recording, undefined).pipe(
								Effect.andThen(Deferred.await(allowRecord)),
								Effect.andThen(real.record(...args)),
							),
					}),
				})
				const resource = {
					namespace: "member",
					kind: "test",
					id: "slow-error-store",
				}
				const held = yield* first.transport.register(resource, () =>
					Stream.unwrap(
						Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
							Deferred.succeed(released, undefined),
						).pipe(Effect.as(Stream.never)),
					),
				)
				const reply = yield* Deferred.make<Resource.Error>()
				yield* first.transport.call(resource, null).pipe(
					Stream.runDrain,
					Effect.flip,
					Effect.flatMap((error) => Deferred.succeed(reply, error)),
					Effect.forkScoped,
				)
				yield* Deferred.await(entered)
				yield* first.transport.closeLocal(held.address)
				yield* Deferred.await(recording)
				assert.isTrue(yield* Deferred.isDone(released))
				assert.isFalse(yield* Deferred.isDone(reply))
				yield* Deferred.succeed(allowRecord, undefined)
				const error = yield* Deferred.await(reply)
				assert.ok(Schema.is(Resource.Failed)(error))
				if (Schema.is(Resource.Failed)(error))
					assert.equal(error.outcome, "unknown")
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)
	it.effect(
		"a lost registration commit reply still leaves one usable resource",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const commits = yield* Ref.make(0)
				const transactions = Layer.mock(SqlClient.SqlClient, {
					...sql,
					withTransaction: (work) =>
						sql.withTransaction(work).pipe(
							Effect.flatMap((value) =>
								Ref.updateAndGet(commits, (n) => n + 1).pipe(
									Effect.flatMap((count) =>
										count === 1
											? Effect.fail(
													SqlError.SqlError.make({
														reason: SqlError.ConnectionError.make({
															cause: "The commit reply was lost.",
														}),
													}),
												)
											: Effect.succeed(value),
									),
								),
							),
						),
				})
				const first = yield* start({ transactions })
				const second = yield* start()
				const resource = {
					namespace: "member",
					kind: "test",
					id: "lost-commit",
				}
				yield* first.transport.register(resource, () => Stream.succeed("one"))
				assert.equal(yield* Ref.get(commits), 1)
				assert.deepEqual(
					yield* second.transport.call(resource, null).pipe(Stream.runCollect),
					["one"],
				)
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	it.effect(
		"an empty row on a live node cannot block a new registration",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const second = yield* start()
				const resource = { namespace: "member", kind: "test", id: "empty" }
				const old = yield* first.directory.prepare(resource)
				yield* first.directory.claim(old, false)
				const current = yield* second.transport.register(resource, () =>
					Stream.succeed("new"),
				)
				assert.notEqual(current.address.lease, old.lease)
				assert.deepEqual(
					yield* first.transport.call(resource, null).pipe(Stream.runCollect),
					["new"],
				)
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	it.effect(
		"interruption while recording an RPC error stays interruption",
		() =>
			Effect.gen(function* () {
				const first = yield* start({
					errors: Records.Records.of({ record: () => Effect.interrupt }),
				})
				const resource = {
					namespace: "member",
					kind: "test",
					id: "record-interrupt",
				}
				const held = yield* first.transport.register(resource, () =>
					Stream.fail("A test call failed."),
				)
				const exit = yield* first.transport
					.dispatch(held.address, null)
					.pipe(Stream.runDrain, Effect.exit)
				assert.ok(Exit.isFailure(exit))
				if (Exit.isFailure(exit)) assert.ok(Cause.hasInterruptsOnly(exit.cause))
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	it.effect(
		"nodes share resource routing and reject an old connection after replacement",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const second = yield* start()
				const resource = { namespace: "member", kind: "test", id: "one" }
				const firstScope = yield* Scope.fork(yield* Scope.Scope)
				const old = yield* first.transport
					.register(resource, (input) => Stream.succeed(input))
					.pipe(Scope.provide(firstScope))
				assert.deepEqual(
					yield* second.transport
						.call(resource, { text: "private" })
						.pipe(Stream.runCollect),
					[{ text: "private" }],
				)
				const http = yield* HttpClient.HttpClient
				assert.equal((yield* http.post(first.url + Transport.path)).status, 401)
				assert.ok(
					Schema.is(Resource.Busy)(
						yield* second.transport
							.register(resource, Stream.succeed)
							.pipe(Effect.flip),
					),
				)
				const current = yield* second.transport.register(
					resource,
					() => Stream.succeed("new"),
					{ replace: true },
				)
				yield* old.lost
				assert.isTrue(
					Option.isNone(
						yield* first.directory.commit(
							old.address,
							Effect.die("An old lease must not write."),
						),
					),
				)
				assert.ok(
					Schema.is(Resource.Gone)(
						yield* second.transport
							.callAt(old.address, null)
							.pipe(Stream.runDrain, Effect.flip),
					),
				)
				yield* Scope.close(firstScope, Exit.void)
				assert.equal(
					Option.getOrThrow(yield* first.directory.find(resource)).lease,
					current.address.lease,
				)
				assert.deepEqual(
					yield* first.transport.call(resource, null).pipe(Stream.runCollect),
					["new"],
				)
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)

	it.effect(
		"losing a connection after a send is unknown and never sends it again",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const second = yield* start()
				const sent = yield* Deferred.make<void>()
				const count = yield* Ref.make(0)
				const resource = { namespace: "member", kind: "test", id: "lost" }
				const heldScope = yield* Scope.fork(yield* Scope.Scope)
				const old = yield* first.transport
					.register(resource, () =>
						Stream.fromEffect(
							Ref.update(count, (n) => n + 1).pipe(
								Effect.andThen(Deferred.succeed(sent, undefined)),
								Effect.andThen(Effect.never),
							),
						),
					)
					.pipe(Scope.provide(heldScope))
				const reply = yield* Deferred.make<Resource.Error>()
				yield* second.transport.call(resource, null).pipe(
					Stream.runDrain,
					Effect.flip,
					Effect.flatMap((error) => Deferred.succeed(reply, error)),
					Effect.forkScoped,
				)
				yield* Deferred.await(sent)
				yield* first.transport.closeLocal(old.address)
				const error = yield* Deferred.await(reply)
				assert.ok(Schema.is(Resource.Failed)(error))
				if (Schema.is(Resource.Failed)(error)) {
					assert.equal(error.outcome, "unknown")
					assert.ok(error.failure.errorId.length > 0)
				}
				assert.equal(yield* Ref.get(count), 1)
				yield* Scope.close(heldScope, Exit.void)
				assert.ok(
					Schema.is(Resource.Gone)(
						yield* second.transport
							.call(resource, null)
							.pipe(Stream.runDrain, Effect.flip),
					),
				)
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)
	it.effect(
		"connector calls share RPC, current rights, ordered output and unknown results",
		() =>
			Effect.gen(function* () {
				const first = yield* start()
				const second = yield* start()
				const allowed = yield* Ref.make(true)
				const policy = Authorizer.layer(Authorization.Auth, {
					policy: (caller) =>
						Effect.map(Ref.get(allowed), (allowed) =>
							Policy.define(Authorization.OpenBot)(function* (_) {
								yield* _.allow("*", "*")
								if (caller.kind === "user_token" && !allowed)
									yield* _.deny("use", Authorization.Computer)
							}),
						),
				})
				const at = (node: typeof first) =>
					Connector.make.pipe(
						Effect.provideService(Transport.Transport, node.transport),
						Effect.provideService(Directory.Directory, node.directory),
						Effect.provide([directAccess, policy, Layer.mock(Bots, {})]),
					)
				const owner = yield* at(first)
				const remote = yield* at(second)
				const id = "connector-rpc"
				const identity: ExecutionIdentity = {
					owner: testActor,
					actor: testActor,
					constraints: [
						{
							...testActor,
							kind: "user_token",
							tokenId: TokenId.make("limited"),
						},
					],
				}
				const db = yield* Db.make
				yield* db.insert(computerRows).values({
					organizationId: testActor.organizationId,
					id,
					ownerUserId: testActor.userId,
					name: "Machine",
					source: "connector",
					state: "running",
					features: '{"desktop":false,"pause":false,"ports":false}',
					createdBy: testActor.userId,
					version: 0,
					createdAt: 0,
					updatedAt: 0,
				})
				const incoming = yield* Queue.unbounded<string, Socket.SocketError>()
				const sent = yield* Ref.make<ReadonlyArray<ComputersApi.ToConnector>>(
					[],
				)
				const disconnected = yield* Ref.make(false)
				const online = yield* Deferred.make<void>()
				const ended = yield* Deferred.make<void>()
				const encode = Schema.encodeEffect(
					Schema.fromJsonString(ComputersApi.FromConnector),
				)
				const decode = Schema.decodeUnknownEffect(
					Schema.fromJsonString(ComputersApi.ToConnector),
				)
				const reply = (message: ComputersApi.FromConnector) =>
					encode(message).pipe(
						Effect.orDie,
						Effect.flatMap((json) => Queue.offer(incoming, json)),
						Effect.asVoid,
					)
				const closeError = Socket.SocketError.make({
					reason: Socket.SocketCloseError.make({ code: 1000 }),
				})
				const write = (frame: string | Uint8Array | Socket.CloseEvent) =>
					Effect.gen(function* () {
						if (yield* Ref.get(disconnected)) return yield* closeError
						if (Socket.isCloseEvent(frame)) {
							yield* Queue.fail(incoming, closeError)
							return
						}
						const message = yield* decode(
							typeof frame === "string"
								? frame
								: new TextDecoder().decode(frame),
						).pipe(Effect.orDie)
						yield* Ref.update(sent, (all) => [...all, message])
						if (
							message._tag === "Call" &&
							message.call.operation._tag === "Read"
						)
							yield* reply({
								_tag: "Reply",
								reply: {
									id: message.call.id,
									result: { _tag: "Done", value: "known" },
								},
							})
						if (message._tag === "Start")
							yield* reply({
								_tag: "Output",
								session: message.session,
								seq: 0,
								data: Base64.encode("first"),
							})
						if (message._tag === "Input") {
							yield* reply({
								_tag: "Output",
								session: message.session,
								seq: 1,
								data: message.data,
							})
							yield* reply({
								_tag: "Exit",
								session: message.session,
								code: 0,
								signal: null,
							})
						}
					})
				const socket = Socket.make({
					reader: Effect.gen(function* () {
						yield* Effect.addFinalizer(() => Queue.fail(incoming, closeError))
						return {
							pull: Queue.take(incoming).pipe(
								Effect.map((frame) => [frame] as const),
							),
							upgrade: () => Effect.void,
						}
					}),
					writer: Effect.succeed({
						write,
						writeAll: (frames) =>
							Effect.forEach(frames, write, { discard: true }),
					}),
				})
				yield* owner
					.serve({
						organizationId: testActor.organizationId,
						computerId: id,
						socket,
						online: () =>
							Deferred.succeed(online, undefined).pipe(Effect.asVoid),
						offline: Effect.void,
					})
					.pipe(
						Effect.ensuring(Deferred.succeed(ended, undefined)),
						Effect.forkScoped,
					)
				yield* reply({
					_tag: "Hello",
					hello: {
						version: ComputersApi.connectorProtocolVersion,
						os: "linux",
						arch: "x64",
						desktop: false,
					},
				})
				yield* Deferred.await(online)
				assert.equal(
					yield* remote.call(identity, id, {
						_tag: "Read",
						path: "/file",
						encoding: "utf8",
					}),
					"known",
				)
				yield* Ref.set(allowed, false)
				const denied = yield* remote
					.call(identity, id, { _tag: "Remove", path: "/file" })
					.pipe(Effect.flip)
				assert.ok(Schema.is(Execution.Failure)(denied))
				if (Schema.is(Execution.Failure)(denied))
					assert.equal(denied.category, "forbidden")
				assert.equal((yield* Ref.get(sent)).length, 1)
				yield* Ref.set(allowed, true)
				const process = yield* remote.start(identity, id, {
					command: "cat",
					tty: false,
				})
				const output = yield* process.output.pipe(
					Stream.runCollect,
					Effect.forkScoped,
				)
				yield* process.write(new TextEncoder().encode("second"))
				assert.deepStrictEqual(yield* process.exit, { code: 0, signal: null })
				assert.equal(
					Arr.join(
						Arr.map(yield* Fiber.join(output), (bytes) =>
							new TextDecoder().decode(bytes),
						),
						"",
					),
					"firstsecond",
				)
				const timedOut = yield* remote
					.call(
						identity,
						id,
						{ _tag: "Remove", path: "/file" },
						Duration.millis(10),
					)
					.pipe(Effect.flip)
				assert.ok(Schema.is(Execution.Failure)(timedOut))
				if (Schema.is(Execution.Failure)(timedOut))
					assert.equal(timedOut.category, "outcome_unknown")
				assert.equal(
					Arr.filter(
						yield* Ref.get(sent),
						(message) =>
							message._tag === "Call" &&
							message.call.operation._tag === "Remove",
					).length,
					1,
				)
				const lost = yield* remote.start(identity, id, {
					command: "cat",
					tty: false,
				})
				// Both sides fail. No resource Close RPC comes to rescue the owner.
				yield* Ref.set(disconnected, true)
				yield* Queue.fail(incoming, closeError)
				const exit = yield* lost.exit
				assert.equal(exit.failure?.category, "outcome_unknown")
				yield* Deferred.await(ended)
			}).pipe(Effect.scoped),
		{ timeout: 60000 },
	)
})
