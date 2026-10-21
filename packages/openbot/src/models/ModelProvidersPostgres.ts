import { ModelProvidersApi } from "@openbot-build/api"
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect"
import { and, asc, eq, or } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { randomUUID } from "node:crypto"
import { modelProviders } from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import {
	ModelProviders,
	type Owner,
	type Stored,
	usableBy,
} from "./ModelProviders.ts"

const Models = Schema.fromJsonString(Schema.Array(ModelProvidersApi.ModelEntry))
const AvailabilityJson = Schema.fromJsonString(ModelProvidersApi.Availability)
const decodeModels = Schema.decodeUnknownSync(Models)
const decodeAvailability = Schema.decodeUnknownSync(AvailabilityJson)
const decodeKind = Schema.decodeUnknownSync(ModelProvidersApi.ProviderKind)

const ownerColumns = (owner: Owner) =>
	owner.kind === "platform"
		? { ownerKind: "platform", ownerId: "platform" }
		: { ownerKind: "organization", ownerId: owner.id }
const binding = (id: string) => "openbot_model_providers:" + id + ":api_key"

const stored = (row: typeof modelProviders.$inferSelect): Stored => ({
	id: row.id,
	owner:
		row.ownerKind === "platform"
			? { kind: "platform" }
			: { kind: "organization", id: row.ownerId },
	kind: decodeKind(row.kind),
	name: row.name,
	endpoint: row.endpoint,
	apiKey: row.apiKey,
	apiKeyHint: row.apiKeyHint,
	models: decodeModels(row.models),
	availability:
		row.availability === null ? null : decodeAvailability(row.availability),
	version: row.version,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

/** An `openai-compat` provider has no default address. */
const checkEndpoint = (
	kind: ModelProvidersApi.ProviderKind,
	endpoint: string | null,
) =>
	kind === "openai-compat" && endpoint === null
		? Effect.fail(
				ModelProvidersApi.ModelProviderInvalid.make({
					message: "An openai-compat provider needs an endpoint.",
				}),
			)
		: Effect.void

export const make = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const secrets = yield* Secrets
	const unavailable = () => ModelProvidersApi.ModelProvidersUnavailable.make({})
	const where = (owner: Owner, id: string) => {
		const columns = ownerColumns(owner)
		return and(
			eq(modelProviders.id, id),
			eq(modelProviders.ownerKind, columns.ownerKind),
			eq(modelProviders.ownerId, columns.ownerId),
		)
	}
	const get = (owner: Owner, id: string) =>
		db
			.select()
			.from(modelProviders)
			.where(where(owner, id))
			.pipe(
				Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), stored)),
				Effect.mapError(unavailable),
			)
	const notFound = (id: string) =>
		ModelProvidersApi.ModelProviderNotFound.make({ providerId: id })

	return ModelProviders.of({
		list: (owner) => {
			const columns = ownerColumns(owner)
			return db
				.select()
				.from(modelProviders)
				.where(
					and(
						eq(modelProviders.ownerKind, columns.ownerKind),
						eq(modelProviders.ownerId, columns.ownerId),
					),
				)
				.orderBy(asc(modelProviders.createdAt))
				.pipe(
					Effect.map((rows) => rows.map(stored)),
					Effect.mapError(unavailable),
				)
		},
		get,
		available: (organizationId) =>
			db
				.select()
				.from(modelProviders)
				.where(
					or(
						eq(modelProviders.ownerKind, "platform"),
						and(
							eq(modelProviders.ownerKind, "organization"),
							eq(modelProviders.ownerId, organizationId),
						),
					),
				)
				.orderBy(asc(modelProviders.createdAt))
				.pipe(
					Effect.map((rows) =>
						rows
							.map(stored)
							.filter((provider) => usableBy({ provider, organizationId })),
					),
					Effect.mapError(unavailable),
				),
		create: (owner, input) =>
			Effect.gen(function* () {
				const endpoint = input.endpoint ?? null
				yield* checkEndpoint(input.kind, endpoint)
				const now = yield* Clock.currentTimeMillis
				const id = "prov_" + randomUUID().replaceAll("-", "")
				const apiKey = yield* secrets
					.seal(input.apiKey, binding(id))
					.pipe(Effect.mapError(unavailable))
				const row = {
					id,
					...ownerColumns(owner),
					kind: input.kind,
					name: input.name.trim(),
					endpoint,
					apiKey,
					apiKeyHint: hint(input.apiKey),
					models: JSON.stringify(input.models),
					availability:
						owner.kind === "platform"
							? JSON.stringify(input.availability)
							: null,
					version: 1,
					createdAt: now,
					updatedAt: now,
				}
				yield* db
					.insert(modelProviders)
					.values(row)
					.pipe(Effect.mapError(unavailable))
				return stored(row)
			}),
		update: (owner, id, patch) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						const [row] = yield* tx
							.select()
							.from(modelProviders)
							.where(where(owner, id))
							.for("update")
						if (row === undefined) return yield* notFound(id)
						if (row.version !== patch.expectedVersion)
							return yield* ModelProvidersApi.ModelProviderConflict.make({
								version: row.version,
							})
						const current = stored(row)
						const endpoint =
							patch.endpoint === undefined ? current.endpoint : patch.endpoint
						yield* checkEndpoint(current.kind, endpoint)
						const now = yield* Clock.currentTimeMillis
						const key =
							patch.apiKey === undefined
								? undefined
								: {
										apiKey: yield* secrets.seal(patch.apiKey, binding(id)),
										apiKeyHint: hint(patch.apiKey),
									}
						const [updated] = yield* tx
							.update(modelProviders)
							.set({
								...(patch.name === undefined
									? {}
									: { name: patch.name.trim() }),
								endpoint,
								...key,
								...(patch.models === undefined
									? {}
									: { models: JSON.stringify(patch.models) }),
								...(patch.availability === undefined ||
								owner.kind !== "platform"
									? {}
									: { availability: JSON.stringify(patch.availability) }),
								version: row.version + 1,
								updatedAt: now,
							})
							.where(where(owner, id))
							.returning()
						if (updated === undefined) return yield* notFound(id)
						return stored(updated)
					}),
				)
				.pipe(
					Effect.mapError((error) =>
						error._tag === "ModelProviderNotFound" ||
						error._tag === "ModelProviderConflict" ||
						error._tag === "ModelProviderInvalid"
							? error
							: unavailable(),
					),
				),
		delete: (owner, id) =>
			db
				.delete(modelProviders)
				.where(where(owner, id))
				.returning({ id: modelProviders.id })
				.pipe(
					Effect.mapError(unavailable),
					Effect.flatMap((rows) =>
						rows.length === 0 ? Effect.fail(notFound(id)) : Effect.void,
					),
				),
		openKey: (provider) =>
			secrets
				.open(provider.apiKey, binding(provider.id))
				.pipe(Effect.map(Redacted.make), Effect.mapError(unavailable)),
	})
})

export const layer = Layer.effect(ModelProviders, make)
