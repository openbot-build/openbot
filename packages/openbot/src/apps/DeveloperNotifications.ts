import { Developers } from "@openbot-build/domain"

import { PgClient } from "@effect/sql-pg"
import { and, desc, eq, lt, or } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	pipe,
} from "effect"
import { developerNotices, developerSubscriptions } from "../database/Schema.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../database/Database.ts"

const pageSize = 50
export class DeveloperNotifications extends Context.Service<
	DeveloperNotifications,
	{
		readonly list: (
			owner: string,
			before?: string,
		) => Effect.Effect<ReadonlyArray<Developers.Notice>, Developers.Failure>
		readonly read: (
			owner: string,
			id: string,
		) => Effect.Effect<Developers.Notice, Developers.Failure>
		readonly subscriptions: (
			owner: string,
		) => Effect.Effect<
			ReadonlyArray<Developers.Subscription>,
			Developers.Failure
		>
		readonly subscribe: (
			owner: string,
			value: Developers.Subscription,
		) => Effect.Effect<Developers.Subscription, Developers.Failure>
	}
>()("@openbot-build/openbot/apps/DeveloperNotifications") {}
export const make: Effect.Effect<
	typeof DeveloperNotifications.Service,
	never,
	PgClient.PgClient | DeveloperAccess
> = Effect.gen(function* () {
	const db = yield* Db.make
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const access = yield* DeveloperAccess
	const visible = (owner: string, notice: Developers.Notice) =>
		notice.cardUrl === null
			? Effect.succeed(true)
			: access.allows(owner, notice.cardUrl)
	const noticeWhere = (owner: string, id: string) =>
		and(
			eq(developerNotices.namespace, namespace),
			eq(developerNotices.owner, owner),
			eq(developerNotices.id, id),
		)
	/** The notices of the owner after the position, newest first. */
	const page = (
		owner: string,
		after: { readonly createdAt: number; readonly id: string } | undefined,
	) =>
		Rows.stored(
			db
				.select()
				.from(developerNotices)
				.where(
					and(
						eq(developerNotices.namespace, namespace),
						eq(developerNotices.owner, owner),
						after === undefined
							? undefined
							: or(
									lt(developerNotices.createdAt, after.createdAt),
									and(
										eq(developerNotices.createdAt, after.createdAt),
										lt(developerNotices.id, after.id),
									),
								),
					),
				)
				.orderBy(desc(developerNotices.createdAt), desc(developerNotices.id))
				.limit(pageSize),
		).pipe(Effect.flatMap((rows) => Effect.forEach(rows, Rows.decodeNotice)))
	return DeveloperNotifications.of({
		list: (owner, before) =>
			Effect.gen(function* () {
				let position:
					{ readonly createdAt: number; readonly id: string } | undefined
				if (before !== undefined) {
					const cursor = (yield* Rows.stored(
						db
							.select({
								createdAt: developerNotices.createdAt,
								id: developerNotices.id,
							})
							.from(developerNotices)
							.where(noticeWhere(owner, before)),
					))[0]
					if (cursor === undefined)
						return yield* Developers.DeveloperInputInvalid.make({
							message:
								"This notification cursor is no longer available. Reload the notifications.",
						})
					position = cursor
				}
				// Some notices are about Apps that the owner can no longer see. Read on until a page is full.
				let allowed: ReadonlyArray<Developers.Notice> = []
				while (allowed.length < pageSize) {
					const rows = yield* page(owner, position)
					allowed = [
						...allowed,
						...(yield* Effect.filter(rows, (value) => visible(owner, value))),
					]
					const last = rows.at(-1)
					if (last === undefined || rows.length < pageSize) break
					position = last
				}
				return allowed.slice(0, pageSize)
			}),
		read: (owner, id) =>
			inTransaction(
				Effect.gen(function* () {
					const row = (yield* Rows.stored(
						db
							.select()
							.from(developerNotices)
							.where(noticeWhere(owner, id))
							.for("update"),
					))[0]
					if (row === undefined)
						return yield* Developers.DeveloperNotFound.make({})
					const notice = yield* Rows.decodeNotice(row)
					if (!(yield* visible(owner, notice)))
						return yield* Developers.DeveloperNotFound.make({})
					if (notice.readAt !== null) return notice
					const readAt = yield* Clock.currentTimeMillis
					yield* Rows.stored(
						db
							.update(developerNotices)
							.set({ readAt })
							.where(noticeWhere(owner, id)),
					)
					return { ...notice, readAt } satisfies Developers.Notice
				}),
			),
		subscriptions: (owner) =>
			Effect.gen(function* () {
				const overview = yield* access.overview(owner)
				const saved = yield* Rows.stored(
					db
						.select()
						.from(developerSubscriptions)
						.where(
							and(
								eq(developerSubscriptions.namespace, namespace),
								eq(developerSubscriptions.owner, owner),
							),
						),
				)
				return Arr.map(overview.apps, (app) => ({
					cardUrl: app.cardUrl,
					enabled: pipe(
						Arr.findFirst(saved, (row) => row.cardUrl === app.cardUrl),
						Option.match({ onNone: () => true, onSome: (row) => row.enabled }),
					),
				}))
			}),
		subscribe: (owner, value) =>
			Effect.gen(function* () {
				yield* access.authorize(owner, value.cardUrl)
				yield* Rows.stored(
					db
						.insert(developerSubscriptions)
						.values({ namespace, owner, ...value })
						.onConflictDoUpdate({
							target: [
								developerSubscriptions.namespace,
								developerSubscriptions.owner,
								developerSubscriptions.cardUrl,
							],
							set: { enabled: value.enabled },
						}),
				)
				return value
			}),
	})
})
export const layer = Layer.effect(DeveloperNotifications, make)
