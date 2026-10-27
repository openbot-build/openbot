import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey } from "./StoredConnections.ts"
import {
	AppConnections,
	Authorization,
	ExperienceStorageUnavailable,
} from "@openbot-build/domain"

import { Identity } from "@openbot-build/domain"
import { Array as Arr, Context, Crypto, Effect, Layer } from "effect"
import { Connections, type Error as ConnectionsError } from "./Connections.ts"
import * as Db from "../database/Database.ts"
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
					})),
				})),
			),
		import: (
			identity: typeof Identity.Service,
			transfer: AppConnections.Transfer,
		) =>
			Effect.forEach(transfer.apps, (entry) =>
				connections.prepareConnection(entry.cardUrl).pipe(
					Effect.provideService(Identity, identity),
					Effect.flatMap((draft) =>
						crypto.randomUUIDv4().pipe(
							Effect.orDie,
							Effect.flatMap((id) =>
								StoredConnections.saveDraft(db, ownerKey(identity), {
									...draft,
									id,
									imported: {
										name: entry.name,
										remoteIndex: entry.remoteIndex,
									},
								}),
							),
						),
					),
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
