import * as Children from "../src/execution/Children.ts"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	Execution,
	Requests,
	ServiceId,
	type ServiceIdentity,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Exit,
	Schema,
	Effect,
	Deferred,
	Fiber,
	Layer,
	Option,
	Redacted,
	Stream,
	String as Str,
} from "effect"
import { SqlError } from "effect/sql"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Records from "../src/errors/Records.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Observation.layer.pipe(
	Layer.provideMerge(Layer.merge(Store.layer, Records.layer)),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const submission = {
	workflow: "test",
	resource: { kind: "Chat", id: "chat-1" },
	identity: {
		owner: { organizationId: "org-1", userId: "user-1" },
		actor: { kind: "member", organizationId: "org-1", userId: "user-1" },
	},
	input: { value: "private text" },
} satisfies Store.Submission

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect("call queries keep steps, attempts, and owners separate", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const namespace = "call-queries"
			const receipt = yield* store.submit(
				namespace,
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace, id: receipt.executionId }
			assert.isTrue(Schema.is(Schema.String.check(Schema.isUUID(7)))(key.id))
			const fence = yield* store.takeOver(key)
			const last = yield* store.intent(fence, {
				step: "model",
				attempt: 3,
				retry: "read_only",
				input: { attempt: 3 },
			})
			const first = yield* store.intent(fence, {
				step: "model",
				attempt: 0,
				retry: "read_only",
				input: { attempt: 0 },
			})
			yield* store.intent(fence, {
				step: "model",
				attempt: 1,
				retry: "read_only",
				input: { attempt: 1 },
			})
			const tool = yield* store.intent(fence, {
				step: "tool",
				attempt: 0,
				retry: "never",
				input: { value: "tool input" },
			})
			const other = yield* store.submit(
				namespace,
				Execution.CommandKey.make("other"),
				submission,
			)
			const otherKey = { namespace, id: other.executionId }
			const otherFence = yield* store.takeOver(otherKey)
			const otherCall = yield* store.intent(otherFence, {
				step: "model",
				attempt: 9,
				retry: "read_only",
				input: { value: "other input" },
			})
			assert.isTrue(Schema.is(Schema.String.check(Schema.isUUID(7)))(tool.id))
			assert.deepEqual(Option.getOrThrow(yield* store.call(key, tool.id)), tool)
			assert.equal(
				Option.getOrThrow(yield* store.firstCall(key, "model")).id,
				first.id,
			)
			assert.equal(
				Option.getOrThrow(yield* store.latestCall(key, "model")).id,
				last.id,
			)
			const latest = yield* store.latestCalls(key)
			assert.equal(latest.length, 2)
			assert.equal(
				Option.getOrThrow(
					Arr.findFirst(latest, (call) => call.step === "model"),
				).id,
				last.id,
			)
			assert.equal(
				Option.getOrThrow(Arr.findFirst(latest, (call) => call.step === "tool"))
					.id,
				tool.id,
			)
			assert.equal(
				Option.getOrThrow(yield* store.latestCall(otherKey, "model")).id,
				otherCall.id,
			)
			assert.isTrue(Option.isNone(yield* store.call(otherKey, last.id)))
			assert.isTrue(Option.isNone(yield* store.firstCall(key, "missing")))
			assert.isTrue(Option.isNone(yield* store.latestCall(key, "missing")))
			const wrongOwner = { ...key, namespace: "other-call-queries" }
			assert.isTrue(Option.isNone(yield* store.call(wrongOwner, last.id)))
			assert.isTrue(Option.isNone(yield* store.firstCall(wrongOwner, "model")))
			assert.isTrue(Option.isNone(yield* store.latestCall(wrongOwner, "model")))
			assert.deepEqual(yield* store.latestCalls(wrongOwner), [])
		}),
	)
	it.effect("a query opens only the calls it needs", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const sql = yield* PgClient.PgClient
			const namespace = "call-query-secrets"
			const receipt = yield* store.submit(
				namespace,
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace, id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			const first = yield* store.intent(fence, {
				step: "model",
				attempt: 0,
				retry: "read_only",
				input: { value: "first input" },
			})
			const last = yield* store.intent(fence, {
				step: "model",
				attempt: 1,
				retry: "read_only",
				input: { value: "last input" },
			})
			yield* store.sending(fence, last.id)
			yield* store.finishCall(fence, last.id, { value: "saved result" })
			yield* sql`update openbot_execution_calls set input = ${"broken secret envelope"} where namespace = ${namespace} and id = ${first.id}`
			const selected = Option.getOrThrow(yield* store.call(key, last.id))
			assert.deepEqual(selected.input, last.input)
			assert.deepEqual(selected.result, { value: "saved result" })
			assert.deepEqual(
				Option.getOrThrow(yield* store.latestCall(key, "model")),
				selected,
			)
			assert.deepEqual(yield* store.latestCalls(key), [selected])
			const failed = yield* store.firstCall(key, "model").pipe(Effect.flip)
			assert.isTrue(Schema.is(Execution.StorageError)(failed))
		}),
	)
	for (const damage of ["seal", "JSON", "identity"] as const) {
		it.effect(
			`a corrupt execution ${damage} is a storage failure, not a missing record`,
			() =>
				Effect.gen(function* () {
					const store = yield* Store.Store
					const sql = yield* PgClient.PgClient
					const secrets = yield* Secrets.Secrets
					const namespace = "corrupt-execution-" + damage
					const receipt = yield* store.submit(
						namespace,
						Execution.CommandKey.make("start"),
						submission,
					)
					const key = { namespace, id: receipt.executionId }
					const [before] = yield* sql<{
						readonly identity: string
						readonly input: string
					}>`select identity, input from openbot_executions where id = ${key.id}`
					assert.isDefined(before)
					const field = damage === "identity" ? "identity" : "input"
					const value =
						damage === "seal"
							? "broken secret envelope"
							: yield* secrets.seal(
									damage === "identity" ? "{}" : "broken JSON",
									yield* Schema.encodeEffect(
										Schema.fromJsonString(Schema.Array(Schema.String)),
									)(["execution", namespace, key.id, field]),
								)
					if (field === "identity")
						yield* sql`update openbot_executions set identity = ${value} where id = ${key.id}`
					else
						yield* sql`update openbot_executions set input = ${value} where id = ${key.id}`
					const failed = yield* store.loadMember(key).pipe(Effect.flip)
					assert.isTrue(Schema.is(Execution.StorageError)(failed))
					assert.isFalse(Schema.is(Execution.NotFound)(failed))
					if (!Schema.is(Execution.StorageError)(failed))
						return assert.fail("Expected a storage failure")
					assert.isTrue(Cause.isCause(failed.cause))
					assert.deepEqual(
						yield* store.locate(
							key.id,
							submission.identity.owner.organizationId,
						),
						key,
					)
					assert.equal((yield* store.get(key)).status, "queued")
					yield* sql`update openbot_executions set identity = ${before!.identity}, input = ${before!.input} where id = ${key.id}`
					assert.deepEqual(
						(yield* store.loadMember(key)).input,
						submission.input,
					)
					const missing = yield* store
						.loadMember({ ...key, id: Execution.Id.make("absent-" + damage) })
						.pipe(Effect.flip)
					assert.isTrue(Schema.is(Execution.NotFound)(missing))
				}),
		)
	}

	it.effect("named signals commit once and roll back with their caller", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const sql = yield* PgClient.PgClient
			const namespace = "named-signal"
			const identity: ServiceIdentity = {
				owner: { kind: "platform" },
				actor: { kind: "service", serviceId: ServiceId.make("index") },
			}
			const submitted = yield* store.submit(
				namespace,
				Execution.CommandKey.make("start"),
				{ ...submission, identity },
			)
			const key = { namespace, id: submitted.executionId }
			const actor = Store.commandActor(identity)
			const notify = (name: string) =>
				store.notify(key, Execution.CommandKey.make("notify"), actor, name)
			const before = (yield* store.get(key)).sequence
			yield* sql
				.withTransaction(
					notify("next").pipe(Effect.andThen(Effect.fail("rollback"))),
				)
				.pipe(Effect.flip)
			assert.strictEqual((yield* store.get(key)).sequence, before)
			assert.strictEqual(
				Arr.filter(
					yield* store.pending([submission.workflow]),
					(message) => message.namespace === namespace,
				).length,
				1,
			)
			const [a, b] = yield* Effect.all([notify("next"), notify("next")], {
				concurrency: 2,
			})
			assert.deepEqual(a, b)
			assert.strictEqual(a.sequence, before + 1)
			const pending = Arr.filter(
				yield* store.pending([submission.workflow]),
				(message) => message.namespace === namespace,
			)
			assert.strictEqual(pending.length, 2)
			const wake = Arr.filter(
				yield* store.events(key, 0),
				(event) => event.body._tag === "Wake",
			)
			assert.strictEqual(wake.length, 1)
			assert.ok(
				Schema.is(Execution.KeyConflict)(
					yield* notify("other").pipe(Effect.flip),
				),
			)
			const fence = yield* store.takeOver(key)
			yield* store.transition(fence, "completed")
			assert.deepEqual(yield* notify("next"), a)
			assert.ok(
				Schema.is(Execution.Conflict)(
					yield* store
						.notify(key, Execution.CommandKey.make("late"), actor, "next")
						.pipe(Effect.flip),
				),
			)
		}),
	)

	it.effect(
		"service commands keep their scope and cannot use member access",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const namespace = "service-work"
				const service = ServiceId.make("index")
				const identity: ServiceIdentity = {
					owner: { kind: "platform" },
					actor: { kind: "service", serviceId: service },
				}
				const input = {
					...submission,
					identity,
					input: { secret: "service input" },
				}
				const command = Execution.CommandKey.make("same-key")
				const [first, duplicate] = yield* Effect.all(
					[
						store.submit(namespace, command, input),
						store.submit(namespace, command, input),
					],
					{ concurrency: 2 },
				)
				assert.deepEqual(first, duplicate)
				const key = { namespace, id: first.executionId }
				assert.deepEqual(
					(yield* store.loadService(key, service)).identity,
					identity,
				)
				assert.ok(
					Schema.is(Execution.Forbidden)(
						yield* store.loadMember(key).pipe(Effect.flip),
					),
				)
				assert.ok(
					Schema.is(Execution.Forbidden)(
						yield* store
							.loadService(key, ServiceId.make("files"))
							.pipe(Effect.flip),
					),
				)
				assert.ok(
					Schema.is(Execution.NotFound)(
						yield* store.locate(key.id, "org-1").pipe(Effect.flip),
					),
				)
				assert.ok(
					Schema.is(Execution.KeyConflict)(
						yield* store
							.submit(namespace, command, { ...input, input: null })
							.pipe(Effect.flip),
					),
				)
				const member = yield* store.submit(namespace, command, submission)
				const scoped = yield* store.submit(namespace, command, {
					...input,
					identity: {
						...identity,
						owner: { kind: "organization", organizationId: "org-1" },
					},
				})
				const other = yield* store.submit(namespace, command, {
					...input,
					identity: {
						...identity,
						actor: { kind: "service", serviceId: ServiceId.make("files") },
					},
				})
				assert.strictEqual(
					Arr.dedupe(
						Arr.map(
							[first, member, scoped, other],
							(receipt) => receipt.executionId,
						),
					).length,
					4,
				)
				assert.ok(
					Schema.is(Execution.Forbidden)(
						yield* store
							.loadService({ namespace, id: member.executionId }, service)
							.pipe(Effect.flip),
					),
				)
				const rows = yield* sql<{
					readonly organization_id: string | null
					readonly user_id: string | null
					readonly identity: string
					readonly input: string
				}>`select organization_id, user_id, identity, input from openbot_executions where id = ${key.id}`
				assert.strictEqual(rows[0]?.organization_id, null)
				assert.strictEqual(rows[0]?.user_id, null)
				assert.isFalse(Str.includes("service input")(rows[0]!.input))
				assert.isFalse(Str.includes('"serviceId"')(rows[0]!.identity))
				const cancelled = yield* store.cancel(
					key,
					Execution.CommandKey.make("stop"),
					Store.commandActor(identity),
				)
				assert.strictEqual(cancelled.executionId, key.id)
				assert.strictEqual((yield* store.get(key)).status, "cancelling")
			}),
	)

	it.effect(
		"service child work stays within its parent's service and scope",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const namespace = "service-children"
				const identity: ServiceIdentity = {
					owner: { kind: "platform" },
					actor: { kind: "service", serviceId: ServiceId.make("index") },
				}
				const input = { ...submission, identity }
				const parent = yield* store.submit(
					namespace,
					Execution.CommandKey.make("parent"),
					input,
				)
				const child = { ...input, ownerExecutionId: parent.executionId }
				const receipt = yield* store.submit(
					namespace,
					Execution.CommandKey.make("child"),
					child,
				)
				assert.deepEqual(
					Arr.map(
						yield* store.owned({ namespace, id: parent.executionId }),
						(entry) => entry.key.id,
					),
					[receipt.executionId],
				)
				for (const next of [
					submission.identity,
					{
						...identity,
						owner: { kind: "organization" as const, organizationId: "org-1" },
					},
					{
						...identity,
						actor: {
							kind: "service" as const,
							serviceId: ServiceId.make("files"),
						},
					},
				]) {
					assert.ok(
						Schema.is(Execution.Forbidden)(
							yield* store
								.submit(namespace, Execution.CommandKey.make("denied"), {
									...child,
									identity: next,
								})
								.pipe(Effect.flip),
						),
					)
				}
			}),
	)

	it.effect(
		"a confirmed result permits one next attempt with the current fence",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const receipt = yield* store.submit(
					"refused-call",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "refused-call", id: receipt.executionId }
				const first = yield* store.takeOver(key)
				const call = yield* store.writeAttempt(first, "send", { text: "Hello" })
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* store.repeatCall(first, call.id, null).pipe(Effect.flip),
					),
				)
				yield* store.sending(first, call.id)
				const refusal = { refused: true, retryAt: 123 }
				yield* store.finishCall(first, call.id, refusal)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* store
							.repeatCall(first, call.id, { refused: false })
							.pipe(Effect.flip),
					),
				)
				const owner = yield* store.takeOver(key)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* store.repeatCall(first, call.id, refusal).pipe(Effect.flip),
					),
				)
				const [a, b] = yield* Effect.all(
					[
						store.repeatCall(owner, call.id, refusal),
						store.repeatCall(owner, call.id, refusal),
					],
					{ concurrency: 2 },
				)
				assert.deepEqual(a, b)
				assert.strictEqual(a.attempt, 1)
				assert.strictEqual(a.status, "intended")
				assert.strictEqual((yield* store.calls(key)).length, 2)
				assert.strictEqual(
					Arr.filter(
						yield* store.events(key, 0),
						(event) =>
							event.body._tag === "StepStarted" && event.body.attempt === 1,
					).length,
					1,
				)
			}),
	)

	it.effect(
		"a wake key is saved once and cannot add events after the end",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const receipt = yield* store.submit(
					"wake",
					Execution.CommandKey.make("start"),
					submission,
				)
				const fence = yield* store.takeOver({
					namespace: "wake",
					id: receipt.executionId,
				})
				const before = (yield* store.get(fence)).sequence
				yield* Effect.all(
					[store.wake(fence, "limit:0"), store.wake(fence, "limit:0")],
					{ concurrency: 2 },
				)
				assert.deepEqual(
					Arr.map(yield* store.events(fence, before), (event) => event.body),
					[{ _tag: "Wake", key: "limit:0" }],
				)
				yield* store.transition(fence, "completed")
				const ended = (yield* store.get(fence)).sequence
				yield* store.wake(fence, "limit:1")
				assert.deepEqual(yield* store.events(fence, ended), [])
			}),
	)

	it.effect(
		"an owner waits across namespaces and through the final notice",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const first = yield* store.submit(
					"ownership",
					Execution.CommandKey.make("owner"),
					submission,
				)
				const owner = { namespace: "ownership", id: first.executionId }
				const fence = yield* store.takeOver(owner)
				const child = yield* store.submit(
					"speaker",
					Execution.CommandKey.make("child"),
					{
						...submission,
						ownerExecutionId: owner.id,
						identity: {
							...submission.identity,
							owner: { ...submission.identity.owner, userId: "speaker" },
						},
					},
				)
				const childKey = { namespace: "speaker", id: child.executionId }
				assert.deepEqual(yield* store.ownership(childKey), {
					ownerExecutionId: owner.id,
				})
				assert.deepEqual(
					Arr.map(yield* store.owned(owner), (entry) => entry.key),
					[childKey],
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* store
							.commit(fence, { status: "completed" }, Effect.void)
							.pipe(Effect.flip),
					),
				)
				const childFence = yield* store.takeOver(childKey)
				const notice = yield* store.commit(
					childFence,
					{ status: "completed" },
					store.submit("speaker", Execution.CommandKey.make("notice"), {
						...submission,
						...(yield* store.ownership(childKey)),
						resource: { kind: "ChatNotice", id: "notice" },
					}),
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* store
							.commit(fence, { status: "completed" }, Effect.void)
							.pipe(Effect.flip),
					),
				)
				const noticeFence = yield* store.takeOver({
					namespace: "speaker",
					id: notice.executionId,
				})
				yield* store.commit(noticeFence, { status: "completed" }, Effect.void)
				yield* store.commit(fence, { status: "completed" }, Effect.void)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* store
							.submit("speaker", Execution.CommandKey.make("late"), {
								...submission,
								ownerExecutionId: owner.id,
							})
							.pipe(Effect.flip),
					),
				)
				assert.equal((yield* store.owned(owner)).length, 2)
			}),
	)
	it.effect(
		"an owner cannot finish cancellation while its work is active",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const first = yield* store.submit(
					"ownership-cancel",
					Execution.CommandKey.make("owner"),
					submission,
				)
				const owner = { namespace: "ownership-cancel", id: first.executionId }
				const fence = yield* store.takeOver(owner)
				const child = yield* store.submit(
					owner.namespace,
					Execution.CommandKey.make("child"),
					{ ...submission, ownerExecutionId: owner.id },
				)
				const childKey = { namespace: owner.namespace, id: child.executionId }
				yield* store.cancel(
					owner,
					Execution.CommandKey.make("cancel"),
					submission.identity.actor,
				)
				const state = yield* store.load(owner)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* store
							.finishCancellation(fence, state.cancelEpoch)
							.pipe(Effect.flip),
					),
				)
				assert.equal((yield* store.get(owner)).status, "cancelling")
				const childFence = yield* store.takeOver(childKey)
				yield* store.cancel(
					childKey,
					Execution.CommandKey.make("cancel-child"),
					submission.identity.actor,
				)
				yield* store.finishCancellation(
					childFence,
					(yield* store.load(childKey)).cancelEpoch,
				)
				yield* store.finishCancellation(fence, state.cancelEpoch)
				assert.equal((yield* store.get(owner)).status, "cancelled")
			}),
	)
	it.effect("an execution cannot join an owner in another organization", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const first = yield* store.submit(
				"ownership-other",
				Execution.CommandKey.make("owner"),
				submission,
			)
			assert.ok(
				Schema.is(Execution.Forbidden)(
					yield* store
						.submit("other-org", Execution.CommandKey.make("child"), {
							...submission,
							ownerExecutionId: first.executionId,
							identity: {
								owner: { organizationId: "other", userId: "other" },
								actor: {
									kind: "member",
									organizationId: "other",
									userId: "other",
								},
							},
						})
						.pipe(Effect.flip),
				),
			)
			assert.equal(
				(yield* store.owned({
					namespace: "ownership-other",
					id: first.executionId,
				})).length,
				0,
			)
		}),
	)
	it.effect(
		"owned cancellation and a child's final notice do not reverse their locks",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const children = yield* Children.make
				const observation = yield* Observation.Observation
				const receipt = yield* store.submit(
					"ownership-release",
					Execution.CommandKey.make("owner"),
					submission,
				)
				const owner = {
					namespace: "ownership-release",
					id: receipt.executionId,
				}
				const fence = yield* store.takeOver(owner)
				const childReceipt = yield* store.submit(
					owner.namespace,
					Execution.CommandKey.make("child"),
					{ ...submission, ownerExecutionId: owner.id },
				)
				const child = {
					namespace: owner.namespace,
					id: childReceipt.executionId,
				}
				const childFence = yield* store.takeOver(child)
				yield* store.cancel(
					owner,
					Execution.CommandKey.make("cancel"),
					submission.identity.actor,
				)
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const ending = yield* store
					.commit(
						childFence,
						{ status: "completed" },
						Effect.gen(function* () {
							yield* Deferred.succeed(entered, undefined)
							yield* Deferred.await(release)
							return yield* store.submit(
								owner.namespace,
								Execution.CommandKey.make("notice"),
								{
									...submission,
									ownerExecutionId: owner.id,
									resource: { kind: "ChatNotice", id: "notice" },
								},
							)
						}),
					)
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const stopping = yield* children
					.stopOwned(fence)
					.pipe(Effect.forkScoped)
				// This database has only this test's two active writers. Cancellation waits for the child's row.
				yield* Effect.gen(function* () {
					while (
						(yield* sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)
							.length === 0
					)
						yield* Effect.sleep("10 millis")
				}).pipe(Effect.timeout("5 seconds"))
				yield* Deferred.succeed(release, undefined)
				const notice = yield* Fiber.join(ending).pipe(
					Effect.timeout("5 seconds"),
				)
				const noticeKey = { namespace: owner.namespace, id: notice.executionId }
				yield* observation.observe(noticeKey, 0).pipe(
					Stream.filter(
						(event) =>
							event.body._tag === "State" && event.body.status === "cancelling",
					),
					Stream.runHead,
					Effect.timeout("5 seconds"),
				)
				const noticeFence = yield* store.takeOver(noticeKey)
				yield* store.finishCancellation(
					noticeFence,
					(yield* store.load(noticeKey)).cancelEpoch,
				)
				yield* Fiber.join(stopping).pipe(Effect.timeout("5 seconds"))
				yield* store.finishCancellation(
					fence,
					(yield* store.load(owner)).cancelEpoch,
				)
				assert.equal((yield* store.get(owner)).status, "cancelled")
				assert.equal((yield* store.owned(owner, true)).length, 0)
			}),
	)
	for (const first of ["end", "child"] as const) {
		it.effect(
			`owner and child acceptance share a lock when ${first} comes first`,
			() =>
				Effect.gen(function* () {
					const store = yield* Store.Store
					const sql = yield* PgClient.PgClient
					const namespace = `ownership-race-${first}`
					const receipt = yield* store.submit(
						namespace,
						Execution.CommandKey.make("owner"),
						submission,
					)
					const owner = { namespace, id: receipt.executionId }
					const fence = yield* store.takeOver(owner)
					const entered = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const accept = store.submit(
						namespace,
						Execution.CommandKey.make("child"),
						{ ...submission, ownerExecutionId: owner.id },
					)
					const end = store.commit(fence, { status: "completed" }, Effect.void)
					const leading = yield* sql
						.withTransaction(
							Effect.gen(function* () {
								if (first === "child") yield* accept
								else yield* end
								yield* Deferred.succeed(entered, undefined)
								yield* Deferred.await(release)
							}),
						)
						.pipe(Effect.forkScoped)
					yield* Deferred.await(entered)
					const following = yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* sql`select set_config('application_name', ${namespace}, true)`
								if (first === "child") yield* end
								else yield* accept
							}),
						)
						.pipe(Effect.flip, Effect.forkScoped)
					yield* Effect.gen(function* () {
						while (
							(yield* sql`select pid from pg_stat_activity where application_name = ${namespace} and wait_event_type = 'Lock'`)
								.length === 0
						)
							yield* Effect.sleep("10 millis")
					}).pipe(Effect.timeout("5 seconds"))
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(leading)
					assert.ok(Schema.is(Execution.Conflict)(yield* Fiber.join(following)))
					assert.equal(
						(yield* store.get(owner)).status,
						first === "end" ? "completed" : "running",
					)
					assert.equal(
						(yield* store.owned(owner)).length,
						first === "end" ? 0 : 1,
					)
				}),
		)
	}
	for (const action of ["cancel", "decide"] as const) {
		it.effect(`input and ${action} use the same command lock order`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const namespace = "command-lock-" + action
				const first = yield* store.submit(
					namespace,
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace, id: first.executionId }
				const commandKey = Execution.CommandKey.make("shared")
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const input = yield* store
					.accept(
						namespace,
						commandKey,
						{ actor: submission.identity.actor, body: { kind: "input" } },
						() =>
							Effect.gen(function* () {
								yield* Deferred.succeed(entered, undefined)
								yield* Deferred.await(release)
								return { executionId: key.id, start: false }
							}),
					)
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const competing = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`select set_config('application_name', ${namespace}, true)`
							return yield* action === "cancel"
								? store.cancel(key, commandKey, submission.identity.actor)
								: store.decide(
										key,
										commandKey,
										"approval",
										"allow",
										submission.identity.actor,
									)
						}),
					)
					.pipe(Effect.flip, Effect.forkScoped)
				// Wait until the competing transaction is blocked on the command advisory lock.
				yield* Effect.gen(function* () {
					while (true) {
						const rows =
							yield* sql`select pid from pg_stat_activity where application_name = ${namespace} and wait_event = 'advisory'`
						if (rows.length > 0) return
						yield* Effect.sleep("10 millis")
					}
				}).pipe(Effect.timeout("5 seconds"))
				yield* Deferred.succeed(release, undefined)
				assert.strictEqual((yield* Fiber.join(input)).executionId, key.id)
				assert.strictEqual(
					(yield* Fiber.join(competing))._tag,
					"ExecutionKeyConflict",
				)
			}),
		)
	}
	it.effect(
		"a restarted model step has a new attempt and reuses a saved result",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const receipt = yield* store.submit(
					"attempts",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "attempts", id: receipt.executionId }
				const first = yield* store.takeOver(key)
				const call = yield* store.readAttempt(first, "model-1", {
					prompt: "hello",
				})
				assert.deepStrictEqual(
					yield* store.readAttempt(first, "model-1", { prompt: "hello" }),
					call,
				)
				yield* store.sending(first, call.id)
				yield* store.commit(
					first,
					{
						events: [
							{ _tag: "Text", step: "model-1", attempt: 0, text: "old text" },
						],
					},
					Effect.void,
				)
				const second = yield* store.takeOver(key)
				const retry = yield* store.readAttempt(second, "model-1", {
					prompt: "hello",
				})
				assert.strictEqual(retry.attempt, 1)
				assert.notStrictEqual(retry.id, call.id)
				const starts = Arr.filter(
					yield* store.events(key, 0),
					(event) => event.body._tag === "StepStarted",
				)
				assert.strictEqual(starts.length, 2)
				yield* store.sending(second, retry.id)
				yield* store.finishCall(second, retry.id, { text: "new text" })
				const third = yield* store.takeOver(key)
				const saved = yield* store.readAttempt(third, "model-1", {
					prompt: "hello",
				})
				assert.strictEqual(saved.attempt, 1)
				assert.deepStrictEqual(saved.result, { text: "new text" })
				assert.strictEqual(
					(yield* store.calls(key))[0]?.status,
					"outcome_unknown",
				)
			}),
	)

	it.effect(
		"a command commits its input and execution once under concurrent retries",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				yield* sql`create table command_inputs (namespace text not null, value text not null)`
				const accept = store.accept(
					"input-command",
					Execution.CommandKey.make("first"),
					{ actor: submission.identity.actor, body: { input: "hello" } },
					(create) =>
						Effect.gen(function* () {
							yield* sql`insert into command_inputs values ('input-command', 'hello')`
							const key = yield* create(submission)
							return { executionId: key.id, start: true }
						}),
				)
				const receipts = yield* Effect.all(Arr.replicate(accept, 20), {
					concurrency: "unbounded",
				})
				const first = Arr.headNonEmpty(receipts)
				for (const receipt of receipts) assert.deepStrictEqual(receipt, first)
				assert.strictEqual(
					(yield* sql`select * from command_inputs where namespace = 'input-command'`)
						.length,
					1,
				)
				assert.strictEqual(
					(yield* sql`select * from openbot_executions where namespace = 'input-command'`)
						.length,
					1,
				)
				assert.strictEqual(
					(yield* sql`select * from openbot_execution_outbox where namespace = 'input-command'`)
						.length,
					1,
				)
				const next = yield* store.accept(
					"input-command",
					Execution.CommandKey.make("steer"),
					{ actor: submission.identity.actor, body: { input: "again" } },
					() =>
						sql`insert into command_inputs values ('input-command', 'again')`.pipe(
							Effect.as({ executionId: first.executionId, start: false }),
						),
				)
				assert.strictEqual(next.executionId, first.executionId)
				assert.strictEqual(
					(yield* sql`select * from command_inputs where namespace = 'input-command'`)
						.length,
					2,
				)
				assert.strictEqual(
					(yield* sql`select * from openbot_execution_outbox where namespace = 'input-command'`)
						.length,
					1,
				)
			}),
	)

	it.effect(
		"a failed command rolls back its execution and can be tried again",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const command = Execution.CommandKey.make("first")
				const input = {
					actor: submission.identity.actor,
					body: { input: "hello" },
				}
				const error = yield* store
					.accept("input-rollback", command, input, (create) =>
						create(submission).pipe(
							Effect.andThen(Effect.fail("The input is not valid.")),
						),
					)
					.pipe(Effect.flip)
				assert.strictEqual(error, "The input is not valid.")
				assert.strictEqual(
					(yield* sql`select * from openbot_executions where namespace = 'input-rollback'`)
						.length,
					0,
				)
				assert.strictEqual(
					(yield* sql`select * from openbot_execution_events where namespace = 'input-rollback'`)
						.length,
					0,
				)
				assert.strictEqual(
					(yield* sql`select * from openbot_execution_commands where namespace = 'input-rollback'`)
						.length,
					0,
				)
				const receipt = yield* store.accept(
					"input-rollback",
					command,
					input,
					(create) =>
						create(submission).pipe(
							Effect.map((key) => ({ executionId: key.id, start: true })),
						),
				)
				assert.strictEqual(
					(yield* store.events(
						{ namespace: "input-rollback", id: receipt.executionId },
						0,
					)).length,
					1,
				)
				const conflict = yield* store
					.accept(
						"input-rollback",
						command,
						{ ...input, body: { input: "other" } },
						() => Effect.die("A changed request must not run."),
					)
					.pipe(Effect.flip)
				assert.strictEqual(conflict._tag, "ExecutionKeyConflict")
			}),
	)

	it.effect(
		"many copies of one command make one execution and one message",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const receipts = yield* Effect.forEach(
					Arr.range(1, 20),
					() =>
						store.submit(
							"dedup",
							Execution.CommandKey.make("same"),
							submission,
						),
					{ concurrency: "unbounded" },
				)
				const first = Arr.headNonEmpty(receipts)
				for (const receipt of receipts) assert.deepStrictEqual(receipt, first)
				const rows =
					yield* sql`select * from openbot_execution_outbox where namespace = 'dedup'`
				assert.strictEqual(rows.length, 1)
				assert.strictEqual(
					(yield* store.events(
						{ namespace: "dedup", id: first.executionId },
						0,
					)).length,
					1,
				)
			}),
	)
	it.effect("a key cannot be used with another input", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const key = Execution.CommandKey.make("same")
			yield* store.submit("key-conflict", key, submission)
			const error = yield* store
				.submit("key-conflict", key, { ...submission, input: "other" })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "ExecutionKeyConflict")
		}),
	)
	it.effect("a later owner stops writes from an old generation", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"fence",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "fence", id: receipt.executionId }
			const old = yield* store.takeOver(key)
			const next = yield* store.takeOver(key)
			assert.strictEqual(next.generation, old.generation + 1)
			const error = yield* store.transition(old, "completed").pipe(Effect.flip)
			assert.strictEqual(error._tag, "ExecutionConflict")
			yield* store.transition(next, "completed")
			assert.strictEqual((yield* store.get(key)).status, "completed")
		}),
	)
	it.effect(
		"failed writes roll back the business state, execution, and events together",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const receipt = yield* store.submit(
					"atomic",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "atomic", id: receipt.executionId }
				const fence = yield* store.takeOver(key)
				const before = yield* store.get(key)
				yield* store
					.commit(fence, { status: "completed" }, sql`select 1 / 0`)
					.pipe(Effect.flip)
				assert.deepStrictEqual(yield* store.get(key), before)
				assert.strictEqual(
					(yield* store.events(key, 0)).length,
					before.sequence,
				)
			}),
	)
	it.effect("cancellation stays pending until the owner stops", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"cancel",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "cancel", id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			const first = yield* store.cancel(
				key,
				Execution.CommandKey.make("stop"),
				submission.identity.actor,
			)
			assert.deepStrictEqual(
				yield* store.cancel(
					key,
					Execution.CommandKey.make("stop"),
					submission.identity.actor,
				),
				first,
			)
			assert.strictEqual((yield* store.get(key)).status, "cancelling")
			assert.strictEqual(
				(yield* store.transition(fence, "completed").pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			assert.strictEqual(
				(yield* store.transition(fence, "cancelled").pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			yield* store.finishCancellation(
				fence,
				(yield* store.load(key)).cancelEpoch,
			)
			assert.strictEqual((yield* store.get(key)).status, "cancelled")
		}),
	)
	for (const status of ["waiting", "outcome_unknown", "cancelling"] as const) {
		it.effect(`work in ${status} cannot commit business writes`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const namespace = "stopped-" + status
				const receipt = yield* store.submit(
					namespace,
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace, id: receipt.executionId }
				const fence = yield* store.takeOver(key)
				if (status === "cancelling")
					yield* store.cancel(
						key,
						Execution.CommandKey.make("stop"),
						submission.identity.actor,
					)
				else yield* store.transition(fence, status)
				const before = yield* store.get(key)
				const result = yield* store
					.commit(
						fence,
						{
							events: [
								{ _tag: "Text", step: "late", attempt: 1, text: "late output" },
							],
						},
						sql`select 1 / 0`,
					)
					.pipe(Effect.flip)
				assert.strictEqual(result._tag, "ExecutionConflict")
				assert.deepStrictEqual(yield* store.get(key), before)
			}),
		)
	}
	it.effect(
		"events use one sequence and keep text sealed in the database",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const receipt = yield* store.submit(
					"events",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "events", id: receipt.executionId }
				const fence = yield* store.takeOver(key)
				yield* Effect.forEach(
					Arr.range(1, 16),
					(attempt) =>
						store.commit(
							fence,
							{
								events: [
									{
										_tag: "Text",
										step: "model",
										attempt,
										text: "private output",
									},
								],
							},
							Effect.void,
						),
					{ concurrency: "unbounded" },
				)
				const events = yield* store.events(key, 0)
				assert.deepStrictEqual(
					Arr.map(events, (event) => event.sequence),
					Arr.range(1, 18),
				)
				const rows = yield* sql<{
					readonly body: string
				}>`select body from openbot_execution_events where namespace = 'events'`
				for (const row of rows)
					assert.isFalse(Str.includes("private output")(row.body))
				const records = yield* sql<{
					readonly input: string
				}>`select input from openbot_executions where namespace = 'events'`
				for (const row of records)
					assert.isFalse(Str.includes("private text")(row.input))
			}),
	)
	it.effect("an observer can read the end again and stop at its cursor", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const observation = yield* Observation.Observation
			const receipt = yield* store.submit(
				"observe-end",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "observe-end", id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			yield* store.transition(fence, "completed")
			const events = yield* Stream.runCollect(observation.observe(key, 1))
			assert.deepStrictEqual(
				Arr.map(events, (event) => event.sequence),
				[2, 3],
			)
			assert.deepStrictEqual(
				yield* Stream.runCollect(observation.observe(key, 3)),
				[],
			)
		}),
	)
	it.effect("an action not yet sent can start after an owner change", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"unsent",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "unsent", id: receipt.executionId }
			const first = yield* store.takeOver(key)
			const call = yield* store.intent(first, {
				step: "write",
				attempt: 1,
				retry: "never",
				input: { value: 1 },
			})
			const next = yield* store.takeOver(key)
			assert.strictEqual(
				(yield* store.sending(next, call.id)).status,
				"sending",
			)
		}),
	)
	it.effect(
		"a lost write response waits for a decision and accepts its late result",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const receipt = yield* store.submit(
					"unknown",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "unknown", id: receipt.executionId }
				const first = yield* store.takeOver(key)
				const call = yield* store.intent(first, {
					step: "write",
					attempt: 1,
					retry: "never",
					input: { value: 1 },
				})
				yield* store.sending(first, call.id)
				const next = yield* store.takeOver(key)
				assert.strictEqual(
					(yield* store.sending(next, call.id)).status,
					"outcome_unknown",
				)
				assert.strictEqual((yield* store.get(key)).status, "outcome_unknown")
				const decisionId = Execution.callDecisionId(call.id)
				assert.isTrue(yield* store.decisionPending(key, decisionId))
				yield* store.finishCall(first, call.id, { saved: true })
				// The old question stays in the log, but its result needs no answer.
				assert.isFalse(yield* store.decisionPending(key, decisionId))
				assert.equal(
					Option.getOrThrow(yield* store.decision(key, decisionId)).answer,
					null,
				)
				yield* store.finishCall(first, call.id, { saved: true })
				const calls = yield* store.calls(key)
				assert.strictEqual(calls[0]?.status, "completed")
				assert.strictEqual((yield* store.get(key)).status, "outcome_unknown")
				assert.strictEqual(
					(yield* store.transition(first, "running").pipe(Effect.flip))._tag,
					"ExecutionConflict",
				)
			}),
	)
	it.effect("an idempotent retry keeps its call ID and saved result", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"safe-retry",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "safe-retry", id: receipt.executionId }
			const first = yield* store.takeOver(key)
			const input = {
				step: "write",
				attempt: 1,
				retry: "idempotent" as const,
				input: { value: 1 },
			}
			const call = yield* store.intent(first, input)
			yield* store.sending(first, call.id)
			const next = yield* store.takeOver(key)
			assert.strictEqual((yield* store.intent(next, input)).id, call.id)
			assert.strictEqual(
				(yield* store.sending(next, call.id)).status,
				"sending",
			)
			yield* store.finishCall(first, call.id, { saved: true })
			assert.strictEqual(
				(yield* store.sending(next, call.id)).status,
				"completed",
			)
			assert.strictEqual(
				(yield* store
					.finishCall(first, call.id, { saved: false })
					.pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
		}),
	)
	it.effect(
		"a result, its ledger write and output events commit together",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const receipt = yield* store.submit(
					"call-output",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "call-output", id: receipt.executionId }
				const first = yield* store.takeOver(key)
				const call = yield* store.intent(first, {
					step: "write",
					attempt: 0,
					retry: "never",
					input: null,
				})
				yield* store.sending(first, call.id)
				yield* sql`create table test_call_ledger (call_id text primary key)`
				const settle =
					sql`insert into test_call_ledger (call_id) values (${call.id}) on conflict do nothing`.pipe(
						Effect.asVoid,
					)
				const count = sql<{
					count: number
				}>`select count(*)::int as count from test_call_ledger`
				const before = (yield* store.get(key)).sequence
				const output = {
					_tag: "ToolOutput",
					step: "write",
					attempt: 0,
					output: "saved text",
				} as const
				yield* sql`create function fail_call_event() returns trigger language plpgsql as $$ begin if NEW.namespace = 'call-output' then raise exception 'event write failed'; end if; return NEW; end; $$`
				yield* sql`create trigger fail_call_event before insert on openbot_execution_events for each row execute function fail_call_event()`
				yield* store
					.finishCall(first, call.id, "saved text", [output], settle)
					.pipe(Effect.flip)
				assert.strictEqual((yield* count)[0]?.count, 0)
				assert.strictEqual((yield* store.calls(key))[0]?.status, "sending")
				assert.strictEqual((yield* store.get(key)).sequence, before)
				yield* sql`drop trigger fail_call_event on openbot_execution_events`
				yield* sql`drop function fail_call_event()`
				yield* store.finishCall(first, call.id, "saved text", [output], settle)
				yield* store.finishCall(first, call.id, "saved text", [output], settle)
				assert.strictEqual((yield* count)[0]?.count, 1)
				assert.strictEqual((yield* store.calls(key))[0]?.status, "completed")
				assert.deepStrictEqual(
					Arr.map(yield* store.events(key, before), (event) => event.body),
					[output, { _tag: "StepCompleted", step: "write", attempt: 0 }],
				)
			}),
	)

	it.effect(
		"a late result cannot publish from the old generation of the same call",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				yield* sql`create table test_late_ledger (call_id text primary key)`
				const receipt = yield* store.submit(
					"call-late-output",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "call-late-output", id: receipt.executionId }
				const first = yield* store.takeOver(key)
				const call = yield* store.intent(first, {
					step: "write",
					attempt: 0,
					retry: "idempotent",
					input: null,
				})
				yield* store.sending(first, call.id)
				const second = yield* store.takeOver(key)
				yield* store.sending(second, call.id)
				const before = (yield* store.get(key)).sequence
				yield* store.finishCall(
					first,
					call.id,
					"saved text",
					[
						{
							_tag: "ToolOutput",
							step: "write",
							attempt: 0,
							output: "saved text",
						},
					],
					sql`insert into test_late_ledger (call_id) values (${call.id})`.pipe(
						Effect.asVoid,
					),
				)
				assert.equal(
					(yield* sql<{
						count: number
					}>`select count(*)::int as count from test_late_ledger`)[0]?.count,
					1,
				)
				assert.strictEqual((yield* store.calls(key))[0]?.status, "completed")
				assert.strictEqual((yield* store.get(key)).sequence, before + 1)
				yield* store.finishCall(second, call.id, "saved text", [
					{
						_tag: "ToolOutput",
						step: "write",
						attempt: 0,
						output: "saved text",
					},
				])
				yield* store.finishCall(second, call.id, "saved text", [
					{
						_tag: "ToolOutput",
						step: "write",
						attempt: 0,
						output: "saved text",
					},
				])
				assert.deepStrictEqual(
					Arr.map(yield* store.events(key, before), (event) => event.body._tag),
					["CallRecorded", "ToolOutput", "StepCompleted"],
				)
			}),
	)

	it.effect("a new observer reads more than one event page", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const observation = yield* Observation.Observation
			const receipt = yield* store.submit(
				"many-events",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "many-events", id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			yield* store.commit(
				fence,
				{
					status: "completed",
					events: Arr.map(Arr.range(1, 300), () => ({
						_tag: "Text" as const,
						step: "model",
						attempt: 1,
						text: "a",
					})),
				},
				Effect.void,
			)
			const events = yield* Stream.runCollect(observation.observe(key, 0))
			assert.deepStrictEqual(
				Arr.map(events, (event) => event.sequence),
				Arr.range(1, 303),
			)
		}),
	)
	it.effect("a State event cannot bypass a state change", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"state-guard",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "state-guard", id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			const input = {
				events: [
					{
						_tag: "State" as const,
						status: "completed" as const,
						failure: null,
					},
				],
			}
			const failed = yield* store
				// @ts-expect-error State events can only come from a state change. Check untyped callers too.
				.commit(fence, input, Effect.void)
				.pipe(Effect.flip)
			assert.strictEqual(failed._tag, "ExecutionConflict")
			assert.strictEqual((yield* store.get(key)).status, "running")
			assert.strictEqual((yield* store.events(key, 0)).length, 2)
		}),
	)
	it.effect("pending cancels give other commands a turn", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			for (const n of Arr.range(1, 130))
				yield* store.submit(
					"outbox-fair",
					Execution.CommandKey.make(`start-${n}`),
					{ ...submission, workflow: "fair" },
				)
			const first = yield* store.pending(["fair"])
			assert.strictEqual(first.length, 128)
			for (const row of first) yield* store.defer(row.namespace, row.commandId)
			const next = yield* store.pending(["fair"])
			assert.isAtLeast(next.length, 2)
			for (const row of Arr.take(next, 2))
				assert.isFalse(
					Arr.some(first, (prior) => prior.commandId === row.commandId),
				)
		}),
	)

	it.effect(
		"unknown workflows do not block commands that this node can handle",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				yield* Effect.forEach(
					Arr.range(1, 130),
					(i) =>
						store.submit(
							"outbox-filter",
							Execution.CommandKey.make(String(i)),
							{ ...submission, workflow: "not-registered" },
						),
					{ concurrency: 8 },
				)
				const receipt = yield* store.submit(
					"outbox-filter",
					Execution.CommandKey.make("known"),
					{ ...submission, workflow: "registered" },
				)
				const pending = yield* store.pending(["registered"])
				assert.deepStrictEqual(
					Arr.map(pending, (row) => row.executionId),
					[receipt.executionId],
				)
				assert.strictEqual(
					(yield* store.pending(["not-registered"])).length,
					128,
				)
			}),
	)
	for (const retry of ["local", "read_only", "idempotent", "never"] as const) {
		it.effect(`cancellation keeps the ${retry} call boundary`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const namespace = `cancel-boundary-${retry}`
				const receipt = yield* store.submit(
					namespace,
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace, id: receipt.executionId }
				const fence = yield* store.takeOver(key)
				const call = yield* store.intent(fence, {
					step: "work",
					attempt: 0,
					retry,
					input: null,
				})
				yield* store.sending(fence, call.id)
				yield* store.cancel(
					key,
					Execution.CommandKey.make("stop"),
					submission.identity.actor,
				)
				const status = yield* store.finishCancellation(
					fence,
					(yield* store.load(key)).cancelEpoch,
				)
				assert.equal(
					status,
					retry === "local" || retry === "read_only"
						? "cancelled"
						: "outcome_unknown",
				)
				assert.equal((yield* store.get(key)).status, status)
				// Closing local work does not claim that it returned a result.
				assert.equal(
					Option.getOrThrow(Arr.head(yield* store.calls(key))).status,
					"outcome_unknown",
				)
				const decision = yield* store.decision(
					key,
					Execution.callDecisionId(
						call.id,
						(yield* store.load(key)).cancelEpoch,
					),
				)
				assert.equal(
					Option.isSome(decision),
					retry === "never" || retry === "idempotent",
				)
				if (retry === "idempotent")
					assert.deepEqual(Option.getOrThrow(decision).choices, ["stop"])
			}),
		)
	}

	it.effect("cancelling an unknown write keeps its result unknown", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"cancel-unknown",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "cancel-unknown", id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			const call = yield* store.intent(fence, {
				step: "write",
				attempt: 1,
				retry: "never",
				input: null,
			})
			yield* store.sending(fence, call.id)
			yield* store.transition(fence, "outcome_unknown", {
				errorId: Execution.ErrorId.make("failure-1"),
				category: "outcome_unknown",
			})
			yield* store.cancel(
				key,
				Execution.CommandKey.make("stop"),
				submission.identity.actor,
			)
			assert.equal((yield* store.get(key)).failure?.errorId, "failure-1")
			assert.isFalse((yield* store.load(key)).phaseFailed)
			yield* store.finishCancellation(
				fence,
				(yield* store.load(key)).cancelEpoch,
			)
			assert.strictEqual((yield* store.get(key)).status, "outcome_unknown")
			yield* store.cancel(
				key,
				Execution.CommandKey.make("stop-again"),
				submission.identity.actor,
			)
			yield* store.finishCancellation(
				fence,
				(yield* store.load(key)).cancelEpoch,
			)
			assert.strictEqual((yield* store.get(key)).status, "outcome_unknown")
			yield* store.decide(
				key,
				Execution.CommandKey.make("retry-after-cancel"),
				Execution.callDecisionId(call.id, (yield* store.load(key)).cancelEpoch),
				"retry",
				submission.identity.actor,
			)
			const next = yield* store.retryCall(fence, call.id)
			assert.notEqual(next.id, call.id)
			assert.equal((yield* store.get(key)).status, "running")
			assert.isNull((yield* store.get(key)).failure)
		}),
	)

	it.effect("old cancel commands cannot end a new phase or a new owner", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"cancel-epoch",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "cancel-epoch", id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			const call = yield* store.writeAttempt(fence, "write", null)
			yield* store.sending(fence, call.id)
			const stop = yield* store.cancel(
				key,
				Execution.CommandKey.make("stop"),
				submission.identity.actor,
			)
			yield* store.cancel(
				key,
				Execution.CommandKey.make("same-phase"),
				submission.identity.actor,
			)
			assert.equal((yield* store.load(key)).cancelEpoch, 1)
			yield* store.finishCancellation(fence, 1)
			yield* store.requestDecision(
				fence,
				Execution.callDecisionId(
					call.id,
					(yield* store.load(fence)).cancelEpoch,
				),
				["retry", "stop"],
			)
			yield* store.decide(
				key,
				Execution.CommandKey.make("retry"),
				Execution.callDecisionId(call.id, (yield* store.load(key)).cancelEpoch),
				"retry",
				submission.identity.actor,
			)
			const next = yield* store.retryCall(fence, call.id)
			assert.equal(next.status, "intended")
			assert.deepStrictEqual(
				yield* store.cancel(
					key,
					Execution.CommandKey.make("stop"),
					submission.identity.actor,
				),
				stop,
			)
			assert.equal((yield* store.get(key)).status, "running")
			yield* store.cancel(
				key,
				Execution.CommandKey.make("stop-again"),
				submission.identity.actor,
			)
			assert.equal((yield* store.load(key)).cancelEpoch, 2)
			const outbox = yield* store.pending([submission.workflow])
			const epochs = yield* Effect.forEach(outbox, (row) =>
				store.command(row.namespace, row.commandId),
			)
			assert.deepStrictEqual(
				Arr.flatMap(epochs, (entry) =>
					Option.isSome(entry) &&
					entry.value.kind === "cancel" &&
					entry.value.executionId === key.id
						? [entry.value.cancelEpoch]
						: [],
				),
				[1, 1, 2],
			)
			assert.equal(
				(yield* store.finishCancellation(fence, 1).pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			const owner = yield* store.takeOver(key)
			assert.equal(
				(yield* store.finishCancellation(fence, 2).pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			// The new attempt never sent. The earlier unknown attempt stays in audit.
			assert.equal(yield* store.finishCancellation(owner, 2), "cancelled")
			assert.equal((yield* store.calls(key))[0]?.status, "outcome_unknown")
			assert.equal(yield* store.finishCancellation(owner, 2), "cancelled")
		}),
	)

	it.effect(
		"decision feature writes commit once with the answer, event and signal",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const receipt = yield* store.submit(
					"decision-feature",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "decision-feature", id: receipt.executionId }
				const fence = yield* store.takeOver(key)
				yield* store.requestDecision(fence, "approval", ["allow", "deny"])
				yield* sql`create table decision_effects (id text primary key, count integer not null)`
				const write =
					sql`insert into decision_effects values ('grant', 1) on conflict (id) do update set count = decision_effects.count + 1`.pipe(
						Effect.asVoid,
					)
				const command = Execution.CommandKey.make("answer")
				const decide = <E, R>(
					apply: Effect.Effect<void, E, R>,
					scope = "once",
				) =>
					store.decide(
						key,
						command,
						"approval",
						"allow",
						submission.identity.actor,
						{ input: { scope }, apply },
					)
				const before = yield* store.events(key, 0)
				const rejected = Requests.RequestConflict.make({
					message: "The request changed.",
				})
				assert.strictEqual(
					yield* decide(write.pipe(Effect.andThen(Effect.fail(rejected)))).pipe(
						Effect.flip,
					),
					rejected,
				)
				assert.equal((yield* sql`select * from decision_effects`).length, 0)
				assert.deepEqual(yield* store.events(key, 0), before)
				assert.equal(
					Option.getOrThrow(yield* store.decision(key, "approval")).answer,
					null,
				)
				const firstSql = SqlError.SqlError.make({
					reason: SqlError.ConnectionError.make({
						cause: "First database failure.",
					}),
				})
				const secondSql = SqlError.SqlError.make({
					reason: SqlError.ConnectionError.make({
						cause: "Second database failure.",
					}),
				})
				const both = Cause.combine(Cause.fail(firstSql), Cause.fail(secondSql))
				const databaseFailure = yield* decide(Effect.failCause(both)).pipe(
					Effect.flip,
				)
				assert.ok(Schema.is(Execution.StorageError)(databaseFailure))
				assert.ok(Cause.isCause(databaseFailure.cause))
				assert.deepStrictEqual(databaseFailure.cause.reasons, both.reasons)
				// A mixed domain and SQL cause must keep both errors and their types.
				const mixed = Cause.combine(Cause.fail(firstSql), Cause.fail(rejected))
				const mixedExit = yield* decide(Effect.failCause(mixed)).pipe(
					Effect.exit,
				)
				assert.ok(Exit.isFailure(mixedExit))
				const reasons = mixedExit.cause.reasons
				assert.equal(reasons.length, 2)
				const domainReason = reasons[1]
				assert.ok(domainReason?._tag === "Fail")
				assert.strictEqual(domainReason.error, rejected)
				const sqlReason = reasons[0]
				assert.ok(
					sqlReason?._tag === "Fail" &&
						Schema.is(Execution.StorageError)(sqlReason.error),
				)
				assert.ok(Cause.isCause(sqlReason.error.cause))
				assert.deepStrictEqual(sqlReason.error.cause.reasons, mixed.reasons)
				// A failed execution event also rolls back the preceding feature write.
				yield* sql`create function reject_decision_event() returns trigger language plpgsql as $$ begin if NEW.sequence = 4 then raise exception 'Fixture decision event failure'; end if; return NEW; end $$`
				yield* sql`create trigger reject_decision_event before insert on openbot_execution_events for each row execute function reject_decision_event()`
				assert.equal(
					(yield* decide(write).pipe(Effect.flip))._tag,
					"ExecutionStorageError",
				)
				assert.equal((yield* sql`select * from decision_effects`).length, 0)
				assert.deepEqual(yield* store.events(key, 0), before)
				assert.equal(
					Option.getOrThrow(yield* store.decision(key, "approval")).answer,
					null,
				)
				yield* sql`drop trigger reject_decision_event on openbot_execution_events`
				yield* sql`drop function reject_decision_event()`
				const answers = yield* Effect.forEach(
					Arr.range(1, 20),
					() => decide(write),
					{ concurrency: 8 },
				)
				assert.isTrue(Arr.every(answers, (answer) => answer.sequence === 4))
				const rows = yield* sql<{
					readonly count: number
				}>`select count from decision_effects`
				assert.equal(rows[0]?.count, 1)
				assert.equal((yield* store.events(key, 0)).length, 4)
				const pending = yield* store.pending(["test"])
				assert.equal(
					Arr.filter(pending, (message) => message.executionId === key.id)
						.length,
					2,
				)
				assert.equal(
					(yield* decide(write, "chat").pipe(Effect.flip))._tag,
					"ExecutionKeyConflict",
				)
				assert.equal(
					(yield* sql<{
						readonly count: number
					}>`select count from decision_effects`)[0]?.count,
					1,
				)
			}),
	)

	it.effect("a decision is saved once with its event and signal", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const receipt = yield* store.submit(
				"decision",
				Execution.CommandKey.make("start"),
				submission,
			)
			const key = { namespace: "decision", id: receipt.executionId }
			const fence = yield* store.takeOver(key)
			yield* store.requestDecision(fence, "approval", ["allow", "deny"])
			assert.strictEqual((yield* store.get(key)).status, "running")
			const command = Execution.CommandKey.make("answer")
			const answers = yield* Effect.forEach(
				Arr.range(1, 20),
				() =>
					store.decide(
						key,
						command,
						"approval",
						"allow",
						submission.identity.actor,
					),
				{ concurrency: 8 },
			)
			assert.isTrue(Arr.every(answers, (answer) => answer.sequence === 4))
			const answer = yield* store.decision(key, "approval")
			assert.isTrue(Option.isSome(answer))
			if (Option.isSome(answer))
				assert.deepStrictEqual(answer.value.answer, {
					answer: "allow",
					actor: submission.identity.actor,
				})
			assert.strictEqual((yield* store.events(key, 0)).length, 4)
			const messages = yield* store.pending(["test"])
			const own = Arr.filter(
				messages,
				(message) => message.executionId === key.id,
			)
			assert.strictEqual(own.length, 2)
			assert.strictEqual(
				(yield* store
					.decide(
						key,
						Execution.CommandKey.make("other"),
						"approval",
						"deny",
						submission.identity.actor,
					)
					.pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			assert.strictEqual(
				(yield* store
					.decide(key, command, "approval", "deny", submission.identity.actor)
					.pipe(Effect.flip))._tag,
				"ExecutionKeyConflict",
			)
		}),
	)
	it.effect(
		"cancel stops a later decision and invalid choices never enter the log",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const receipt = yield* store.submit(
					"cancel-decision",
					Execution.CommandKey.make("start"),
					submission,
				)
				const key = { namespace: "cancel-decision", id: receipt.executionId }
				const fence = yield* store.takeOver(key)
				yield* store.requestDecision(fence, "approval", ["allow", "deny"])
				assert.strictEqual(
					(yield* store
						.decide(
							key,
							Execution.CommandKey.make("bad"),
							"approval",
							"retry",
							submission.identity.actor,
						)
						.pipe(Effect.flip))._tag,
					"ExecutionConflict",
				)
				yield* store.cancel(
					key,
					Execution.CommandKey.make("stop"),
					submission.identity.actor,
				)
				assert.strictEqual(
					(yield* store
						.decide(
							key,
							Execution.CommandKey.make("answer"),
							"approval",
							"allow",
							submission.identity.actor,
						)
						.pipe(Effect.flip))._tag,
					"ExecutionConflict",
				)
				assert.isTrue(
					Arr.every(
						yield* store.events(key, 0),
						(event) => event.body._tag !== "DecisionMade",
					),
				)
			}),
	)
})
