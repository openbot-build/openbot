import { ModelProvidersApi } from "@openbot-build/api"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { and, asc, eq, or } from "drizzle-orm"
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
const decodeOptions = Schema.decodeUnknownSync(Options)
const decodeAvailability = Schema.decodeUnknownSync(AvailabilityJson)
const encodeOptions = Schema.encodeSync(Options)
const encodeAvailability = Schema.encodeSync(AvailabilityJson)
const decodeType = Schema.decodeUnknownSync(ModelProvidersApi.ModelType)

const stored = (row: typeof models.$inferSelect): StoredModel => ({
	owner: ownerOf(row),
	id: row.id,
	type: decodeType(row.type),
	name: row.name,
	reasoningEfforts: decodeOptions(row.reasoningEfforts),
	serviceTiers: decodeOptions(row.serviceTiers),
	contextWindow: row.contextWindow,
	maxOutputTokens: row.maxOutputTokens,
	availability:
		row.availability === null ? null : decodeAvailability(row.availability),
	version: row.version,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

type KnownError =
	| ModelProvidersApi.ModelNotFound
	| ModelProvidersApi.ModelConflict
	| ModelProvidersApi.ModelInUse
const isKnown = (error: unknown): error is KnownError =>
	error instanceof ModelProvidersApi.ModelNotFound ||
	error instanceof ModelProvidersApi.ModelConflict ||
	error instanceof ModelProvidersApi.ModelInUse

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
		effect.pipe(
			Effect.mapError((error) =>
				isKnown(error)
					? error
					: ModelProvidersApi.ModelProvidersUnavailable.make({}),
			),
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
					Effect.map((rows) => rows.map(stored)),
					Effect.mapError(() =>
						ModelProvidersApi.ModelProvidersUnavailable.make({}),
					),
				)
		},
		get: (owner, id) =>
			db
				.select()
				.from(models)
				.where(where(owner, id))
				.pipe(
					Effect.map((rows) =>
						Option.map(Option.fromNullishOr(rows[0]), stored),
					),
					Effect.mapError(() =>
						ModelProvidersApi.ModelProvidersUnavailable.make({}),
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
					Effect.map((rows) =>
						rows
							.map(stored)
							.filter((model) => usableBy({ provider: model, organizationId })),
					),
					Effect.mapError(() =>
						ModelProvidersApi.ModelProvidersUnavailable.make({}),
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
						name: input.name.trim(),
						reasoningEfforts: encodeOptions(input.reasoningEfforts),
						serviceTiers: encodeOptions(input.serviceTiers),
						contextWindow: input.contextWindow ?? null,
						maxOutputTokens: input.maxOutputTokens ?? null,
						availability:
							owner.kind === "platform"
								? encodeAvailability(input.availability)
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
					if (inserted[0] !== undefined) return stored(inserted[0])
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
								modelId: id,
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
									: { name: patch.name.trim() }),
								...(patch.reasoningEfforts === undefined
									? {}
									: {
											reasoningEfforts: encodeOptions(patch.reasoningEfforts),
										}),
								...(patch.serviceTiers === undefined
									? {}
									: { serviceTiers: encodeOptions(patch.serviceTiers) }),
								...(patch.contextWindow === undefined
									? {}
									: { contextWindow: patch.contextWindow }),
								...(patch.maxOutputTokens === undefined
									? {}
									: { maxOutputTokens: patch.maxOutputTokens }),
								...(patch.availability === undefined ||
								owner.kind !== "platform"
									? {}
									: { availability: encodeAvailability(patch.availability) }),
								version: row.version + 1,
								updatedAt: now,
							})
							.where(where(owner, id))
							.returning()
						if (updated === undefined)
							return yield* ModelProvidersApi.ModelNotFound.make({
								modelId: id,
							})
						return stored(updated)
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
								modelId: id,
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
							links.some(
								(link) =>
									link.ownerKind === columns.ownerKind &&
									link.ownerId === columns.ownerId,
							)
						)
							return yield* ModelProvidersApi.ModelInUse.make({ modelId: id })
						const others = links.map((link) => link.providerId)
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
							for (const providerId of new Set(others)) {
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
