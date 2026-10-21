import { randomUUID } from "node:crypto"
import { Repository, ownerKey } from "./Repository.ts"
import {
	AppExperienceApi as Api,
	ExperienceStorageUnavailable,
	Identity,
} from "@openbot-build/api"
import { Array as Arr, Context, Effect, Layer } from "effect"
import { Connections } from "./Connections.ts"
import { Lifecycle } from "./Lifecycle.ts"
export const make = Effect.gen(function* () {
	const connections = yield* Connections
	const lifecycle = yield* Lifecycle
	const repository = yield* Repository
	return {
		export: (identity: typeof Identity.Service) =>
			connections.listConnections.pipe(
				Effect.provideService(Identity, identity),
				Effect.mapError(() => ExperienceStorageUnavailable.make({})),
				Effect.map((rows): Api.Transfer => ({
					format: "openbot-apps-v1",
					apps: rows.map((row) => ({
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
						repository.saveDraft(ownerKey(identity), {
							...draft,
							id: randomUUID(),
							imported: { name: entry.name, remoteIndex: entry.remoteIndex },
						}),
					),
					Effect.match({
						onSuccess: (draft) => ({ entry, draft, error: null }),
						onFailure: () => ({
							entry,
							draft: null,
							error:
								"The App could not be discovered. Review its public address before trying again.",
						}),
					}),
				),
			).pipe(Effect.map((entries) => ({ entries }))),
		reset: (identity: typeof Identity.Service) =>
			Effect.gen(function* () {
				const rows = yield* connections.listConnections.pipe(
					Effect.provideService(Identity, identity),
					Effect.mapError(() => ExperienceStorageUnavailable.make({})),
				)
				const results = yield* Effect.forEach(rows, (row) =>
					lifecycle.remove(row.id).pipe(
						Effect.provideService(Identity, identity),
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
				yield* repository.clearDrafts(ownerKey(identity))
				return { removed, pending }
			}),
	}
})
export class Experience extends Context.Service<
	Experience,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/Experience") {}
export const layer = Layer.effect(Experience, make)
