import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Effect, Option, Ref } from "effect"
import * as Approvals from "../src/capabilities/Approvals.ts"
import { RequestCommands } from "../src/capabilities/RequestCommands.ts"
import { Requests } from "../src/capabilities/Requests.ts"
import { Store } from "../src/execution/Store.ts"
import * as Fixture from "./GateFixture.ts"

layer(Fixture.services, { excludeTestServices: true, timeout: "60 seconds" })(
	(it) => {
		it.effect("a waiting approval keeps its full call through takeover", () =>
			Effect.gen(function* () {
				const test = yield* Fixture.setup("approval-call")
				const gate = yield* test.build()
				const answer = yield* gate.check(test.attempt)
				if (answer._tag !== "Pending")
					return assert.fail("Expected a waiting request")
				const pending = Chat.Decision.Pending({
					result: Approvals.pendingResult(answer.request),
				})
				assert.deepEqual(
					yield* Approvals.durable(gate).decide(test.approval),
					pending,
				)
				const saved = Option.getOrThrow(
					yield* (yield* Requests).find(
						Fixture.actor.organizationId,
						answer.request,
					),
				)
				assert.deepEqual(saved.call, {
					name: test.call.name,
					params: { query: "A private note." },
					source: { view: "private-view" },
				})
				const resumed = yield* test.build(
					yield* (yield* Store).takeOver(test.fence),
				)
				assert.deepEqual(yield* resumed.check(test.attempt), answer)
				assert.deepEqual(
					yield* Approvals.durable(resumed).decide(test.approval),
					pending,
				)
				assert.lengthOf(
					yield* (yield* Requests).forChat(
						Fixture.actor.organizationId,
						test.frame.chat,
					),
					1,
				)
			}),
		)

		it.effect("a saved waiting answer needs no second request lookup", () =>
			Effect.gen(function* () {
				const test = yield* Fixture.setup("approval-read-down")
				const commands = yield* RequestCommands
				const unavailable = yield* Ref.make(false)
				const gate = yield* test.build().pipe(
					Effect.provideService(RequestCommands, {
						...commands,
						load: (key) =>
							Ref.get(unavailable).pipe(
								Effect.flatMap((down) =>
									down
										? Effect.fail(
												Execution.StorageError.make({
													cause: "The request store is down.",
												}),
											)
										: commands.load(key),
								),
							),
					}),
				)
				const answer = yield* gate.check(test.attempt)
				if (answer._tag !== "Pending")
					return assert.fail("Expected a waiting request")
				yield* Ref.set(unavailable, true)
				assert.deepEqual(
					yield* Approvals.durable(gate).decide(test.approval),
					Chat.Decision.Pending({
						result: Approvals.pendingResult(answer.request),
					}),
				)
			}),
		)

		it.effect(
			"a failed call write rolls back the request and its notification",
			() =>
				Effect.gen(function* () {
					const test = yield* Fixture.setup("approval-write-down")
					const sql = yield* PgClient.PgClient
					yield* sql`create function reject_approval_command() returns trigger language plpgsql as $$ begin if NEW.key like 'request:%' then raise exception 'The command store is down.'; end if; return NEW; end $$`
					yield* sql`create trigger reject_approval_command before insert on openbot_execution_commands for each row execute function reject_approval_command()`
					yield* Effect.addFinalizer(() =>
						sql`drop trigger if exists reject_approval_command on openbot_execution_commands`.pipe(
							Effect.orDie,
						),
					)
					const gate = yield* test.build()
					const answer = yield* Approvals.durable(gate).decide(test.approval)
					assert.equal(answer._tag, "Deny")
					assert.isEmpty(
						yield* (yield* Requests).forChat(
							Fixture.actor.organizationId,
							test.frame.chat,
						),
					)
					const children =
						yield* sql`select id from openbot_executions where namespace = ${test.fence.namespace} and id <> ${test.fence.id}`
					assert.isEmpty(children)
					const outbox =
						yield* sql`select execution_id from openbot_execution_outbox where namespace = ${test.fence.namespace} and execution_id <> ${test.fence.id}`
					assert.isEmpty(outbox)
					yield* sql`drop trigger reject_approval_command on openbot_execution_commands`
					const resumed = yield* test.build(
						yield* (yield* Store).takeOver(test.fence),
					)
					assert.equal(
						(yield* Approvals.durable(resumed).decide(test.approval))._tag,
						"Pending",
					)
					const saved = yield* (yield* Requests).forChat(
						Fixture.actor.organizationId,
						test.frame.chat,
					)
					assert.lengthOf(saved, 1)
					assert.deepEqual(saved[0]?.call?.params, test.call.params)
				}),
		)
	},
)
