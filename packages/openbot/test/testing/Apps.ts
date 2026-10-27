import { AppIndexApi } from "@openbot-build/api"
import { Item } from "@openbot-build/core"
import type { Identity } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Deferred,
	Fiber,
	Schedule,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
} from "effect"
import { Connections } from "../../src/apps/Connections.ts"
import { PublicIndex } from "../../src/apps/Index.ts"
import { ownerKey } from "../../src/apps/StoredConnections.ts"
import * as Db from "../../src/database/Database.ts"
import { appSecrets, chatItems } from "../../src/database/Schema.ts"
import * as StoredViews from "../../src/apps/StoredViews.ts"
import { SqlClient } from "effect/sql"
import * as Assistance from "../../src/plugins/apps/Assistance.ts"
import * as Report from "../../src/errors/Report.ts"
import { Settings } from "../../src/settings/Settings.ts"
import { Readers, VaultReadFailed } from "../../src/vaults/Readers.ts"
import type * as BrowserHost from "../BrowserHost.ts"

type Host = Effect.Success<ReturnType<typeof BrowserHost.start>>
type Owner = { readonly organizationId: string; readonly userId: string }

/** Records the public queries of App assistance, with an offline Index path. */
export const assistance = (host: Host, identity: typeof Identity.Service) =>
	host.run(
		Effect.gen(function* () {
			const index = yield* PublicIndex
			const connections = yield* Connections
			const report = yield* Report.make
			const queries = yield* Ref.make<ReadonlyArray<AppIndexApi.Query>>([])
			const tracked = PublicIndex.of({
				...index,
				search: (query) =>
					Ref.update(queries, Arr.append(query)).pipe(
						Effect.andThen(index.search(query)),
					),
			})
			const entries = Assistance.entries({
				identity,
				index: tracked,
				connections,
				report,
				occupied: [Assistance.names.search, Assistance.names.search + "_1"],
			})
			const unavailable = Assistance.entries({
				identity,
				connections,
				report,
				occupied: [],
				index: PublicIndex.of({
					...index,
					search: () =>
						Effect.fail(
							AppIndexApi.IndexUnavailable.make({
								issues: [
									{ source: "fixture", message: "The source is offline." },
								],
							}),
						),
				}),
			})
			const context = { preliminary: () => Effect.void }
			return {
				queries: Ref.get(queries),
				searchName: entries[0]!.tool.name,
				search: (input: unknown) => entries[0]!.handle(input, context),
				details: (input: unknown) => entries[1]!.handle(input, context),
				access: entries[2]!.handle({}, context),
				offlineSearch: (input: unknown) =>
					unavailable[0]!.handle(input, context),
			}
		}),
	)

/** A password manager that can reject a token, stop answering, or lack a field. */
export const passwordReaderLayer = (input: { readonly password: string }) =>
	Layer.succeed(
		Readers,
		Readers.of({
			make: (credentials) => ({
				verify:
					credentials.kind !== "bitwarden" &&
					Redacted.value(credentials.token) === "bad"
						? Effect.fail(
								VaultReadFailed.make({ retry: false, message: "Wrong token" }),
							)
						: credentials.kind !== "bitwarden" &&
							  Redacted.value(credentials.token) === "offline"
							? Effect.fail(
									VaultReadFailed.make({ retry: true, message: "No answer" }),
								)
							: Effect.void,
				read: (_source, fields) =>
					Arr.every(fields, (field) => field === "password")
						? Effect.succeed(
								new Map(
									Arr.map(fields, (field) => [field, input.password] as const),
								),
							)
						: Effect.fail(
								VaultReadFailed.make({
									retry: false,
									message: "No such field",
								}),
							),
			}),
		}),
	)

/** Adds a result with the same call ID in a later step, to test view ownership. */
export const copyResultAtNextStep = (
	host: Host,
	input: {
		readonly owner: Owner
		readonly chat: string
		readonly item: string
	},
) =>
	host.run(
		Effect.gen(function* () {
			const db = yield* Db.make
			const rows = yield* db
				.select()
				.from(chatItems)
				.where(
					and(
						eq(chatItems.namespace, ownerKey(input.owner)),
						eq(chatItems.chat, input.chat),
					),
				)
			const saved = yield* Effect.fromOption(
				Arr.findFirst(rows, (row) => row.id === input.item),
			)
			const entry = yield* Schema.decodeEffect(
				Schema.fromJsonString(Item.Record),
			)(saved.value)
			const origin = yield* Effect.fromNullishOr(entry.origin)
			const next = {
				...entry,
				id: Item.Id.make("other-step-result"),
				seq: Item.Seq.make(
					1 + Arr.reduce(rows, 0, (max, row) => Math.max(max, row.seq)),
				),
				origin: { ...origin, step: origin.step + 1 },
			}
			yield* db.insert(chatItems).values({
				...saved,
				id: next.id,
				seq: next.seq,
				value: yield* Schema.encodeEffect(Schema.fromJsonString(Item.Record))(
					next,
				),
			})
			return { id: next.id, origin }
		}),
	)

/** Removes the extra history row made by the view ownership check. */
export const removeCopiedResult = (
	host: Host,
	input: {
		readonly owner: Owner
		readonly chat: string
		readonly item: string
	},
) =>
	host.run(
		Effect.gen(function* () {
			const db = yield* Db.make
			yield* db
				.delete(chatItems)
				.where(
					and(
						eq(chatItems.namespace, ownerKey(input.owner)),
						eq(chatItems.chat, input.chat),
						eq(chatItems.id, input.item),
					),
				)
		}),
	)

/** Changes Code Mode for the next turn of the test host. */
export const setCodeModeEnabled = (host: Host, enabled: boolean) =>
	host.run(
		Effect.gen(function* () {
			const settings = yield* Settings
			const current = yield* settings.platform
			if (Option.isNone(current)) return
			yield* settings.updatePlatform(current.value.version, (document) =>
				Effect.succeed({
					...document,
					codeMode: { ...document.codeMode!, enabled },
				}),
			)
		}),
	)

/** Closes a view in one database session while another request waits for its row. */
export const closeViewBefore = <A, E, R>(
	host: Host,
	input: { readonly owner: Owner; readonly id: string },
	request: Effect.Effect<A, E, R>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const held = yield* Deferred.make<number>()
			const release = yield* Deferred.make<void>()
			const closing = yield* host
				.run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						const db = yield* Db.make
						return yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* db
									.update(appSecrets)
									.set({ consumed: true })
									.where(
										StoredViews.where(
											ownerKey(input.owner),
											"app-view",
											input.id,
										),
									)
								const [row] = yield* sql<{
									readonly pid: number
								}>`select pg_backend_pid() as pid`
								yield* Deferred.succeed(held, row!.pid)
								yield* Deferred.await(release)
							}),
						)
					}),
				)
				.pipe(Effect.forkScoped)
			const pid = yield* Deferred.await(held)
			const waiting = yield* request.pipe(Effect.forkScoped)
			yield* host
				.run(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql<{ readonly waiting: boolean }>`select exists(
						select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
					) as waiting`.pipe(
							Effect.repeat({
								until: (rows) => rows[0]?.waiting === true,
								schedule: Schedule.spaced("10 millis"),
							}),
							Effect.timeout("5 seconds"),
						)
					}),
				)
				.pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
			yield* Fiber.join(closing)
			return yield* Fiber.join(waiting)
		}),
	)
