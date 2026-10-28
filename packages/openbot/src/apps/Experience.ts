import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey } from "./StoredConnections.ts"
import {
	AppConnections,
	Authorization,
	ExperienceStorageUnavailable,
} from "@openbot-build/domain"

import { Identity } from "@openbot-build/domain"
import { Array as Arr, Clock, Context, Crypto, Effect, Layer } from "effect"
import { Connections, type Error as ConnectionsError } from "./Connections.ts"
import * as Db from "../database/Database.ts"
import * as ManualConnection from "./ManualConnection.ts"
import * as Failures from "../errors/Failures.ts"

/**
 * Keep the Experience errors of a Connections call. The other Connections
 * errors are not part of these endpoints, so they become unavailable.
 */
const experienceErrors =
	(message: string) =>
	<A, R>(
		effect: Effect.Effect<
			A,
			ConnectionsError | Authorization.PolicyUnavailable,
			R
		>,
	) =>
		effect.pipe(
			Effect.catchTag(
				[
					"AppDiscoveryFailed",
					"ConnectionConflict",
					"ConnectionConfigurationInvalid",
					"AppRestricted",
					"PolicyUnavailable",
				],
				(error) =>
					Effect.fail(error).pipe(
						Failures.replace(message, () =>
							ExperienceStorageUnavailable.make({}),
						),
					),
			),
		)

export const make = Effect.gen(function* () {
	const connections = yield* Connections
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	const prepare = (
		identity: typeof Identity.Service,
		entry: typeof AppConnections.Entry.Type,
	) => {
		const manual = entry.manual
		return manual === undefined
			? connections.prepareConnection(entry.cardUrl).pipe(
					Effect.provideService(Identity, identity),
					Effect.flatMap((draft) =>
						Effect.gen(function* () {
							return yield* StoredConnections.saveDraft(
								db,
								ownerKey(identity),
								{
									...draft,
									id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
									imported: {
										name: entry.name,
										remoteIndex: entry.remoteIndex,
									},
								},
							)
						}),
					),
				)
			: Effect.gen(function* () {
					const draft = yield* ManualConnection.draft(ownerKey(identity), {
						id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
						name: entry.name,
						manual,
						expiresAt: (yield* Clock.currentTimeMillis) + 24 * 60 * 60 * 1000,
					})
					return yield* StoredConnections.saveDraft(
						db,
						ownerKey(identity),
						draft,
					)
				})
	}
	return {
		export: (identity: typeof Identity.Service) =>
			connections.listConnections.pipe(
				Effect.provideService(Identity, identity),
				experienceErrors("App connections could not be listed"),
				Effect.map((rows): AppConnections.Transfer => ({
					format: "openbot-apps-v1",
					apps: Arr.map(rows, (row) => ({
						name: row.name,
						cardUrl: row.cardUrl,
						remoteIndex: row.remoteIndex,
						...(Arr.some(row.sources, (source) => source.role === "manual")
							? {
									manual: {
										url: row.endpoint,
										transport: "streamable-http" as const,
										headers: Arr.map(
											row.card.remotes?.[row.remoteIndex]?.headers ?? [],
											(header) => header.name,
										),
									},
								}
							: {}),
					})),
				})),
			),
		import: (
			identity: typeof Identity.Service,
			transfer: AppConnections.Transfer,
		) =>
			Effect.forEach(transfer.apps, (entry) =>
				prepare(identity, entry).pipe(
					Effect.map((draft) => ({ entry, draft, error: null })),
					Effect.catchTag("AppDiscoveryFailed", (failure) =>
						Effect.succeed({
							entry,
							draft: null,
							error: Arr.join(
								[
									`The App could not be discovered (${failure.reason}). Review its public address before trying again.`,
									...Arr.map(failure.issues, (issue) => issue.reason),
								],
								" ",
							),
						}),
					),
					experienceErrors("An App could not be prepared for import"),
				),
			).pipe(Effect.map((entries) => ({ entries }))),
	}
})
export class Experience extends Context.Service<
	Experience,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/Experience") {}
export const layer = Layer.effect(Experience, make)
