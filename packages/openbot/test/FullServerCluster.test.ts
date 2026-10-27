import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	ChatCommandReceipt,
	ExecutionsApi,
	RequestsApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Schedule,
	Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Caller from "./Caller.ts"
import * as DevelopmentLogin from "./DevelopmentLogin.ts"
import * as Messages from "./Messages.ts"
import * as PostgresTest from "./PostgresTest.ts"

const publicOrigin = "https://localhost:8443"
const poll = <A, E, R>(
	read: Effect.Effect<A, E, R>,
	ready: (value: A) => boolean,
) =>
	read.pipe(
		Effect.repeat({ until: ready, schedule: Schedule.spaced("50 millis") }),
		Effect.timeout("90 seconds"),
	)
const record = (send: Messages.Send, id: Execution.Id) =>
	send(`/v1/executions/${id}`, "GET").pipe(
		Effect.flatMap(Caller.json(Execution.Record)),
	)
const observe = (send: Messages.Send, id: Execution.Id, afterSequence = 0) =>
	send(
		`/v1/executions/${id}/observe?afterSequence=${afterSequence}`,
		"GET",
	).pipe(
		Effect.flatMap((response) => {
			assert.equal(response.status, 200)
			return response.text
		}),
		Effect.timeout("90 seconds"),
	)

layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"full servers share HTTP commands and recover a Turn after node and database loss",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				yield* Effect.gen(function* () {
					yield* DatabasePostgres.migrate
					const sql = yield* PgClient.PgClient
					yield* sql`create table full_server_nodes (node integer primary key, address text not null)`
					yield* sql`create table full_server_calls (
					call_id text primary key, execution_id text not null, node integer not null, sends integer not null)`
					yield* sql`create table full_server_tools (chat text not null, node integer not null, description text not null)`
					yield* sql`create table full_server_faults (bot text primary key, lock_id integer not null)`
					// Stop a real Chat write only after its model result has committed.
					yield* sql`create function full_server_checkpoint() returns trigger language plpgsql as $$
				declare held integer;
				begin
					select lock_id into held from full_server_faults where bot = new.bot;
					if held is not null and exists (
						select 1 from openbot_executions e join openbot_execution_calls c
							on c.execution_id = e.id and c.namespace = e.namespace
						where e.namespace = new.namespace and e.resource_kind = 'Turn'
							and e.resource_id = new.turn and c.status = 'completed'
					) then perform pg_advisory_xact_lock(78421, held); end if;
					return new;
				end $$`
					yield* sql`create trigger full_server_checkpoint before update on openbot_chats
					for each row execute function full_server_checkpoint()`
					const spawn = Effect.fn(function* (node: number) {
						const url = new URL(database.url)
						url.searchParams.set("application_name", `full-server-${node}`)
						const child = yield* spawner.spawn(
							ChildProcess.make(
								"node",
								[
									"--disable-warning=ExperimentalWarning",
									new URL("./FullServerNode.ts", import.meta.url).pathname,
								],
								{
									extendEnv: true,
									env: {
										FULL_SERVER_DATABASE_URL: url.href,
										FULL_SERVER_NODE: String(node),
									},
									stdout: "inherit",
									stderr: "inherit",
								},
							),
						)
						const rows = yield* poll(
							sql<{
								readonly address: string
							}>`select address from full_server_nodes where node = ${node}`,
							(rows) => rows.length === 1,
						).pipe(
							Effect.raceFirst(
								child.exitCode.pipe(
									Effect.flatMap((code) =>
										Effect.die(
											`The server ${node} stopped before it was ready: ${code}`,
										),
									),
								),
							),
						)
						return { node, child, address: rows[0]!.address }
					})
					const first = yield* spawn(1)
					const second = yield* spawn(2)
					const session = yield* DevelopmentLogin.signIn(
						first.address,
						publicOrigin,
					)
					const asCookie = (server: typeof first): Messages.Send =>
						DevelopmentLogin.browser(
							server.address,
							publicOrigin,
							session.credential,
						)
					const token = yield* session
						.send("/v1/user/tokens", "POST", { name: "Cluster test" })
						.pipe(Effect.flatMap(Caller.json(UserTokensApi.CreatedToken, 201)))
					const asToken =
						(server: typeof first): Messages.Send =>
						(path, method, payload) =>
							Caller.withToken(server.address)(
								token.secret,
								path,
								method,
								payload,
							)
					// Both nodes accept commands, and either credential sees the same event log.
					for (const [submitter, reader] of [
						[first, second],
						[second, first],
					] as const) {
						const send = asCookie(submitter)
						const read = asToken(reader)
						const bot = yield* Messages.bot(send)
						const body = {
							input: "Read on either server",
							commandKey: `same-input-${submitter.node}`,
						}
						const receipt = yield* send(
							`/v1/bots/${bot}/messages`,
							"POST",
							body,
						).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
						assert.deepEqual(
							yield* asCookie(reader)(
								`/v1/bots/${bot}/messages`,
								"POST",
								body,
							).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202))),
							receipt,
						)
						const events = yield* observe(read, receipt.executionId)
						assert.match(events, /Development response: Read on either server/)
						assert.match(events, /"status":"completed"/)
						assert.equal(
							(yield* record(send, receipt.executionId)).status,
							"completed",
						)
					}
					// Approval stays durable after the Turn has finished, and another node resolves it.
					const approvalBot = yield* Messages.bot(asToken(first), {
						model: Messages.model("mock-tool"),
					})
					const approval = yield* Messages.message(
						asToken(first),
						approvalBot,
						"Approve on another server",
					)
					yield* observe(asCookie(second), approval.executionId)
					const pending = yield* poll(
						asCookie(second)("/v1/requests?status=pending", "GET").pipe(
							Effect.flatMap(
								Caller.json(Schema.Array(RequestsApi.CapabilityRequest)),
							),
						),
						(rows) =>
							Arr.some(rows, (request) => request.chat === approval.chat),
					)
					const request = Arr.findFirst(
						pending,
						(request) => request.chat === approval.chat,
					)
					const choice = yield* Effect.fromOption(request)
					assert.equal(
						(yield* sql`select * from full_server_tools where chat = ${approval.chat}`)
							.length,
						0,
					)
					const answer = {
						commandKey: "allow-on-another-server",
						expected: choice.revision,
						decision: "allow",
					}
					const allowed = yield* asCookie(second)(
						`/v1/requests/${choice.id}`,
						"POST",
						answer,
					).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
					assert.deepEqual(
						yield* asCookie(first)(
							`/v1/requests/${choice.id}`,
							"POST",
							answer,
						).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202))),
						allowed,
					)
					yield* observe(asToken(first), allowed.executionId)
					yield* poll(
						sql`select * from full_server_tools where chat = ${approval.chat}`,
						(rows) => rows.length === 1,
					)
					assert.equal(
						(yield* sql`select * from full_server_tools where chat = ${approval.chat}`)
							.length,
						1,
					)
					// Cancel from the other node while the provider stream is still open.
					const slowBot = yield* Messages.bot(asCookie(second), {
						model: Messages.model("mock-slow"),
					})
					const slow = yield* Messages.message(
						asCookie(second),
						slowBot,
						"Cancel this stream",
					)
					yield* poll(
						asToken(first)(
							`/v1/executions/${slow.executionId}/events`,
							"GET",
						).pipe(Effect.flatMap(Caller.json(ExecutionsApi.EventPage))),
						(page) =>
							Arr.some(page.events, (event) => event.body._tag === "Text"),
					)
					assert.equal(
						(yield* record(asToken(first), slow.executionId)).status,
						"running",
					)
					const cancelled = yield* asToken(first)(
						`/v1/executions/${slow.executionId}/cancel`,
						"POST",
						{
							commandKey: "cancel-on-another-server",
						},
					).pipe(Effect.flatMap(Caller.json(Execution.Receipt)))
					assert.equal(cancelled.executionId, slow.executionId)
					assert.match(
						yield* observe(asCookie(second), slow.executionId),
						/"status":"cancelled"/,
					)
					assert.equal(
						(yield* Messages.view(asCookie(first), slow.chat)).status,
						"Interrupted",
					)

					const failAtCheckpoint = Effect.fn(function* (
						servers: readonly [typeof first, typeof first],
						kind: "process" | "database",
						lockId: number,
					) {
						const bot = yield* Messages.bot(asToken(servers[0]))
						yield* sql`insert into full_server_faults (bot, lock_id) values (${bot}, ${lockId})`
						const locked = yield* Deferred.make<void>()
						const release = yield* Deferred.make<void>()
						const lock = yield* sql
							.withTransaction(
								Effect.gen(function* () {
									yield* sql`select pg_advisory_xact_lock(78421, ${lockId})`
									yield* Deferred.succeed(locked, undefined)
									yield* Deferred.await(release)
								}),
							)
							.pipe(Effect.forkScoped)
						yield* Deferred.await(locked)
						const receipt = yield* Messages.message(
							asToken(servers[0]),
							bot,
							`Save before ${kind} loss`,
						)
						const blocked = yield* poll(
							sql<{ readonly pid: number }>`
						select pid from pg_locks where locktype = 'advisory' and classid = 78421
							and objid = ${lockId} and not granted`,
							(rows) => rows.length > 0,
						)
						const calls = yield* sql<{
							readonly node: number
							readonly status: string
							readonly sends: number
						}>`
						select f.node, c.status, f.sends from full_server_calls f
						join openbot_execution_calls c on c.id = f.call_id
						where f.execution_id = ${receipt.executionId}`
						assert.equal(calls.length, 1)
						assert.equal(calls[0]!.status, "completed")
						assert.equal(calls[0]!.sends, 1)
						const owner =
							servers[0].node === calls[0]!.node ? servers[0] : servers[1]
						const other =
							servers[0].node === owner.node ? servers[1] : servers[0]
						const observing = yield* observe(
							asCookie(other),
							receipt.executionId,
						).pipe(Effect.forkScoped)
						const before = yield* sql<{
							readonly generation: number
						}>`select generation from openbot_executions where id = ${receipt.executionId}`
						yield* sql`delete from full_server_faults where bot = ${bot}`
						if (kind === "process")
							yield* owner.child.kill({ killSignal: "SIGKILL" })
						else {
							const stopped = yield* sql<{
								readonly pid: number
								readonly stopped: boolean
							}>`
							select pid, pg_terminate_backend(pid) as stopped from pg_stat_activity
							where datname = current_database() and application_name = ${`full-server-${owner.node}`}`
							assert.isTrue(
								Arr.some(
									stopped,
									(entry) => entry.pid === blocked[0]!.pid && entry.stopped,
								),
							)
						}
						yield* Deferred.succeed(release, undefined)
						yield* Fiber.join(lock)
						const events = yield* Fiber.join(observing)
						assert.match(events, /"status":"completed"/)
						assert.match(
							events,
							new RegExp(`Development response: Save before ${kind} loss`),
						)
						assert.equal(
							(yield* record(asToken(other), receipt.executionId)).status,
							"completed",
						)
						const chat = yield* Messages.view(asCookie(other), receipt.chat)
						assert.equal(chat.status, "Completed")
						assert.equal(chat.response?.id, receipt.turn)
						const after = yield* sql<{
							readonly generation: number
						}>`select generation from openbot_executions where id = ${receipt.executionId}`
						if (kind === "process")
							assert.isAbove(after[0]!.generation, before[0]!.generation)
						const sent = yield* sql<{
							readonly sends: number
						}>`select sends from full_server_calls where execution_id = ${receipt.executionId}`
						assert.deepEqual(sent, [{ sends: 1 }])
						const page = yield* asToken(other)(
							`/v1/executions/${receipt.executionId}/events`,
							"GET",
						).pipe(Effect.flatMap(Caller.json(ExecutionsApi.EventPage)))
						assert.equal(
							Arr.filter(page.events, (event) => event.body._tag === "Text")
								.length,
							1,
						)
						assert.equal(
							Arr.filter(
								page.events,
								(event) => event.body._tag === "StepCompleted",
							).length,
							1,
						)
						return { owner, other }
					})
					const killed = yield* failAtCheckpoint([first, second], "process", 1)
					const replacement = yield* spawn(3)
					yield* failAtCheckpoint([killed.other, replacement], "database", 2)
				}).pipe(
					Effect.provide(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
					),
				)
			}),
		{ timeout: 240_000 },
	)
})
