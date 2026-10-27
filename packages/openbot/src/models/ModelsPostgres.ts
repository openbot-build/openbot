import { Model } from "@openbot-build/core"
import { ModelProvidersApi } from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Effect,
	Layer,
	Option,
	Schema,
	String as Str,
} from "effect"
import { and, asc, eq, or } from "drizzle-orm"
import * as Failures from "../app/Failures.ts"
import { modelProviders, models, providerModels } from "../database/Schema.ts"
import {
	ownerColumns,
	ownerOf,
	type Owner,
	usableBy,
} from "./ModelProviders.ts"
import { Models, type StoredModel } from "./Models.ts"
import * as Db from "../database/Database.ts"

const Options = Schema.fromJsonString(Schema.Array(Schema.String))
const AvailabilityJson = Schema.fromJsonString(ModelProvidersApi.Availability)
const decodeOptions = Schema.decodeUnknownEffect(Options)
const decodeAvailability = Schema.decodeUnknownEffect(AvailabilityJson)
const decodeType = Schema.decodeUnknownEffect(ModelProvidersApi.ModelType)
/** The values have their types already, so they always encode. */
const encodeOptions = (options: typeof Options.Type) =>
	Schema.encodeEffect(Options)(options).pipe(Effect.orDie)
const encodeAvailability = (availability: typeof AvailabilityJson.Type) =>
	Schema.encodeEffect(AvailabilityJson)(availability).pipe(Effect.orDie)

/** Turns an inside failure into one public error. The log keeps the reason. */
const unavailable = (message: string) =>
	Failures.replace(message, () =>
		ModelProvidersApi.ModelProvidersUnavailable.make({}),
	)

/** A row with a bad value makes the store unavailable. */
const stored = (
	row: typeof models.$inferSelect,
): Effect.Effect<StoredModel, ModelProvidersApi.ModelProvidersUnavailable> =>
	Effect.gen(function* () {
		return {
			owner: ownerOf(row),
			id: row.id,
			type: yield* decodeType(row.type),
			name: row.name,
			reasoningEfforts: yield* decodeOptions(row.reasoningEfforts),
			serviceTiers: yield* decodeOptions(row.serviceTiers),
			contextWindow: row.contextWindow,
			maxOutputTokens: row.maxOutputTokens,
			availability:
				row.availability === null
					? null
					: yield* decodeAvailability(row.availability),
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}
	}).pipe(unavailable("A stored model has a bad value"))

/** The errors that go to the client as they are. A `ModelProvidersUnavailable` here is in the log already. */
const Known = Schema.Union([
	ModelProvidersApi.ModelNotFound,
	ModelProvidersApi.ModelConflict,
	ModelProvidersApi.ModelInUse,
	ModelProvidersApi.ModelProvidersUnavailable,
])
const isKnown = Schema.is(Known)

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const where = (owner: Owner, id: string) => {
		const columns = ownerColumns(owner)
		return and(
			eq(models.ownerKind, columns.ownerKind),
			eq(models.ownerId, columns.ownerId),
			eq(models.id, id),
		)
	}
	/** Keep the errors of the API, and turn database errors into one error. */
	const known = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.catchIf(
			effect,
			(error): error is Exclude<E, typeof Known.Type> => !isKnown(error),
			(error) =>
				Effect.fail(error).pipe(unavailable("Could not change the model")),
		)

	return Models.of({
		list: (owner) => {
			const columns = ownerColumns(owner)
			return db
				.select()
				.from(models)
				.where(
					and(
						eq(models.ownerKind, columns.ownerKind),
						eq(models.ownerId, columns.ownerId),
					),
				)
				.orderBy(asc(models.createdAt), asc(models.id))
				.pipe(
					unavailable("Could not list the models"),
					Effect.flatMap((rows) => Effect.forEach(rows, stored)),
				)
		},
		get: (owner, id) =>
			db
				.select()
				.from(models)
				.where(where(owner, id))
				.pipe(
					unavailable("Could not read the model"),
					Effect.flatMap((rows) =>
						Effect.transposeOption(Option.map(Arr.head(rows), stored)),
					),
				),
		available: (organizationId) =>
			db
				.select()
				.from(models)
				.where(
					or(
						eq(models.ownerKind, "platform"),
						and(
							eq(models.ownerKind, "organization"),
							eq(models.ownerId, organizationId),
						),
					),
				)
				.orderBy(asc(models.createdAt), asc(models.id))
				.pipe(
					unavailable("Could not list the models"),
					Effect.flatMap((rows) => Effect.forEach(rows, stored)),
					Effect.map(
						Arr.filter((model) =>
							usableBy({ provider: model, organizationId }),
						),
					),
				),
		create: (owner, input) =>
			known(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const row = {
						...ownerColumns(owner),
						id: input.id,
						type: input.type ?? "language",
						name: Str.trim(input.name),
						reasoningEfforts: yield* encodeOptions(input.reasoningEfforts),
						serviceTiers: yield* encodeOptions(input.serviceTiers),
						contextWindow: input.contextWindow ?? null,
						maxOutputTokens: input.maxOutputTokens ?? null,
						availability:
							owner.kind === "platform"
								? yield* encodeAvailability(input.availability)
								: null,
						version: 1,
						createdAt: now,
						updatedAt: now,
					}
					const inserted = yield* db
						.insert(models)
						.values(row)
						.onConflictDoNothing()
						.returning()
					if (inserted[0] !== undefined) return yield* stored(inserted[0])
					const [existing] = yield* db
						.select({ version: models.version })
						.from(models)
						.where(where(owner, input.id))
					return yield* ModelProvidersApi.ModelConflict.make({
						version: existing?.version ?? 0,
					})
				}),
			),
		update: (owner, id, patch) =>
			known(
				db.transaction((tx) =>
					Effect.gen(function* () {
						const [row] = yield* tx
							.select()
							.from(models)
							.where(where(owner, id))
							.for("update")
						if (row === undefined)
							return yield* ModelProvidersApi.ModelNotFound.make({
								modelId: Model.Id.make(id),
							})
						if (row.version !== patch.expectedVersion)
							return yield* ModelProvidersApi.ModelConflict.make({
								version: row.version,
							})
						const now = yield* Clock.currentTimeMillis
						const [updated] = yield* tx
							.update(models)
							.set({
								...(patch.name === undefined
									? {}
									: { name: Str.trim(patch.name) }),
								...(patch.reasoningEfforts === undefined
									? {}
									: {
											reasoningEfforts: yield* encodeOptions(
												patch.reasoningEfforts,
											),
										}),
								...(patch.serviceTiers === undefined
									? {}
									: { serviceTiers: yield* encodeOptions(patch.serviceTiers) }),
								...(patch.contextWindow === undefined
									? {}
									: { contextWindow: patch.contextWindow }),
								...(patch.maxOutputTokens === undefined
									? {}
									: { maxOutputTokens: patch.maxOutputTokens }),
								...(patch.availability === undefined ||
								owner.kind !== "platform"
									? {}
									: {
											availability: yield* encodeAvailability(
												patch.availability,
											),
										}),
								version: row.version + 1,
								updatedAt: now,
							})
							.where(where(owner, id))
							.returning()
						if (updated === undefined)
							return yield* ModelProvidersApi.ModelNotFound.make({
								modelId: Model.Id.make(id),
							})
						return yield* stored(updated)
					}),
				),
			),
		delete: (owner, id) =>
			known(
				db.transaction((tx) =>
					Effect.gen(function* () {
						const columns = ownerColumns(owner)
						const [row] = yield* tx
							.select({ id: models.id })
							.from(models)
							.where(where(owner, id))
							.for("update")
						if (row === undefined)
							return yield* ModelProvidersApi.ModelNotFound.make({
								modelId: Model.Id.make(id),
							})
						const links = yield* tx
							.select({
								providerId: providerModels.providerId,
								ownerKind: modelProviders.ownerKind,
								ownerId: modelProviders.ownerId,
							})
							.from(providerModels)
							.innerJoin(
								modelProviders,
								eq(modelProviders.id, providerModels.providerId),
							)
							.where(
								and(
									eq(providerModels.modelOwnerKind, columns.ownerKind),
									eq(providerModels.modelOwnerId, columns.ownerId),
									eq(providerModels.modelId, id),
								),
							)
						if (
							Arr.some(
								links,
								(link) =>
									link.ownerKind === columns.ownerKind &&
									link.ownerId === columns.ownerId,
							)
						)
							return yield* ModelProvidersApi.ModelInUse.make({
								modelId: Model.Id.make(id),
							})
						const others = Arr.map(links, (link) => link.providerId)
						if (others.length > 0) {
							const now = yield* Clock.currentTimeMillis
							yield* tx
								.delete(providerModels)
								.where(
									and(
										eq(providerModels.modelOwnerKind, columns.ownerKind),
										eq(providerModels.modelOwnerId, columns.ownerId),
										eq(providerModels.modelId, id),
									),
								)
							for (const providerId of Arr.dedupe(others)) {
								const [provider] = yield* tx
									.select({ version: modelProviders.version })
									.from(modelProviders)
									.where(eq(modelProviders.id, providerId))
									.for("update")
								if (provider === undefined) continue
								yield* tx
									.update(modelProviders)
									.set({ version: provider.version + 1, updatedAt: now })
									.where(eq(modelProviders.id, providerId))
							}
						}
						yield* tx.delete(models).where(where(owner, id))
					}),
				),
			),
	})
})

export const layer = Layer.effect(Models, make)
