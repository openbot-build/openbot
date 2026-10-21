import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { Clock, Context, Effect, Layer } from "effect"
import { DeveloperRepository } from "./DeveloperRepository.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { dual } from "effect/Function"

export const subscriptionId: {
	(cardUrl: string): (owner: string) => string
	(owner: string, cardUrl: string): string
} = dual(2, (owner: string, cardUrl: string): string =>
	JSON.stringify([owner, cardUrl]),
)
export class DeveloperNotifications extends Context.Service<
	DeveloperNotifications,
	{
		readonly list: (
			owner: string,
			before?: string,
		) => Effect.Effect<ReadonlyArray<Api.Notice>, Api.Failure>
		readonly read: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.Notice, Api.Failure>
		readonly subscriptions: (
			owner: string,
		) => Effect.Effect<ReadonlyArray<Api.Subscription>, Api.Failure>
		readonly subscribe: (
			owner: string,
			value: Api.Subscription,
		) => Effect.Effect<Api.Subscription, Api.Failure>
	}
>()("@openbot-build/platform/apps/DeveloperNotifications") {}
export const make: Effect.Effect<
	typeof DeveloperNotifications.Service,
	never,
	DeveloperRepository | DeveloperAccess
> = Effect.gen(function* () {
	const records = yield* DeveloperRepository
	const access = yield* DeveloperAccess
	const visible = (owner: string, notice: Api.Notice) =>
		notice.cardUrl === null
			? Effect.succeed(true)
			: access.allows(owner, notice.cardUrl)
	return DeveloperNotifications.of({
		list: (owner, before) =>
			Effect.gen(function* () {
				const all = (yield* records.notices.list({ owner }))
					.map((record) => record.value)
					.toSorted(
						(a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
					)
				const start =
					before === undefined
						? 0
						: all.findIndex((value) => value.id === before) + 1
				if (before !== undefined && start === 0)
					return yield* Api.DeveloperInputInvalid.make({
						message:
							"This notification cursor is no longer available. Reload the notifications.",
					})
				const allowed = yield* Effect.filter(all.slice(start), (value) =>
					visible(owner, value),
				)
				return allowed.slice(0, 50)
			}),
		read: (owner, id) =>
			records.transaction(
				"notice:" + id,
				Effect.gen(function* () {
					const record = yield* records.notices.get(id)
					if (record.owner !== owner || !(yield* visible(owner, record.value)))
						return yield* Api.DeveloperNotFound.make({})
					const value: Api.Notice = {
						...record.value,
						readAt: record.value.readAt ?? (yield* Clock.currentTimeMillis),
					}
					yield* records.notices.put(id, owner, record.value.cardUrl ?? "", {
						owner,
						value,
					})
					return value
				}),
			),
		subscriptions: (owner) =>
			Effect.gen(function* () {
				const overview = yield* access.overview(owner)
				const saved = yield* records.subscriptions.list({ owner })
				return overview.apps.map(
					(app) =>
						saved.find((record) => record.value.cardUrl === app.cardUrl)
							?.value ?? { cardUrl: app.cardUrl, enabled: true },
				)
			}),
		subscribe: (owner, value) =>
			Effect.gen(function* () {
				yield* access.authorize(owner, value.cardUrl)
				yield* records.subscriptions.put(
					subscriptionId(owner, value.cardUrl),
					owner,
					value.cardUrl,
					{ owner, value },
				)
				return value
			}),
	})
})
export const layer = Layer.effect(DeveloperNotifications, make)
