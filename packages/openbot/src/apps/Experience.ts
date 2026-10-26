import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey } from "./StoredConnections.ts"
import {
	AppExperienceApi as Api,
	ExperienceStorageUnavailable,
	Identity,
} from "@openbot-build/api"
import { Array as Arr, Context, Crypto, Effect, Layer } from "effect"
import { and, eq, inArray } from "drizzle-orm"
import { appDrafts, appSecrets } from "../database/Schema.ts"
import { Connections, type Error as ConnectionsError } from "./Connections.ts"
import { Lifecycle } from "./Lifecycle.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"

/**
 * Keep the Experience errors of a Connections call. The other Connections
 * errors are not part of these endpoints, so they become unavailable.
 */
const experienceErrors =
	(message: string) =>
	<A, R>(effect: Effect.Effect<A, ConnectionsError, R>) =>
		effect.pipe(
			Effect.catchTag(
				[
					"AppDiscoveryFailed",
					"ConnectionConflict",
					"ConnectionConfigurationInvalid",
					"AppRestricted",
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
	const lifecycle = yield* Lifecycle
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	return {
		export: (identity: typeof Identity.Service) =>
			connections.listConnections.pipe(
				Effect.provideService(Identity, identity),
				experienceErrors("App connections could not be listed"),
				Effect.map((rows): Api.Transfer => ({
					format: "openbot-apps-v1",
					apps: Arr.map(rows, (row) => ({
						name: row.name,
						cardUrl: row.cardUrl,
						remoteIndex: row.remoteIndex,
					})),
				})),
			),
		import: (identity: typeof Identity.Service, transfer: Api.Transfer) =>
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
		reset: (identity: typeof Identity.Service) =>
			Effect.gen(function* () {
				const rows = yield* connections.listConnections.pipe(
					Effect.provideService(Identity, identity),
					experienceErrors("App connections could not be listed"),
				)
				const results = yield* Effect.forEach(rows, (row) =>
					lifecycle.remove(row.id).pipe(
						Effect.provideService(Identity, identity),
						// A connection that is already gone counts as removed.
						Effect.catchTag("ExperienceNotFound", () => Effect.void),
						Effect.as(row.id),
						Effect.mapError((failure): Api.Reset["pending"][number] => ({
							id: row.id,
							name: row.name,
							stage:
								failure._tag === "ConnectionCleanupPending"
									? failure.stage
									: "Connection cleanup",
						})),
						Effect.result,
					),
				)
				const [removed, pending] = Arr.separate(results)
				const owner = ownerKey(identity)
				// Remove the preparation drafts and the saved App interface state.
				yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.delete(appDrafts).where(eq(appDrafts.owner, owner))
							yield* tx
								.delete(appSecrets)
								.where(
									and(
										eq(appSecrets.owner, owner),
										inArray(appSecrets.kind, [
											"app-view",
											"app-ui-state",
											"app-view-action",
										]),
									),
								)
						}),
					)
					.pipe(
						Failures.replace(
							"App drafts and interface state could not be removed",
							() => ExperienceStorageUnavailable.make({}),
						),
					)
				return { removed, pending }
			}),
	}
})
export class Experience extends Context.Service<
	Experience,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/Experience") {}
export const layer = Layer.effect(Experience, make)
