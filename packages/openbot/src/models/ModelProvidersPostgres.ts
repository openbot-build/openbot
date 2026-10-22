import { ModelProvidersApi } from "@openbot-build/api"
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect"
import { and, asc, eq, inArray, or } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { randomUUID } from "node:crypto"
import { modelProviders, models, providerModels } from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import {
	linkedOwner,
	ModelProviders,
	type Owner,
	ownerColumns,
	ownerOf,
	type Stored,
	usableBy,
} from "./ModelProviders.ts"

const Options = Schema.fromJsonString(Schema.Array(Schema.String))
const AvailabilityJson = Schema.fromJsonString(ModelProvidersApi.Availability)
const decodeOptions = Schema.decodeUnknownSync(Options)
const decodeAvailability = Schema.decodeUnknownSync(AvailabilityJson)
const decodeKind = Schema.decodeUnknownSync(ModelProvidersApi.ProviderKind)

const binding = (id: string) => "openbot_model_providers:" + id + ":api_key"

type LinkRow = typeof providerModels.$inferSelect

const link = (row: LinkRow): ModelProvidersApi.ProviderModel => ({
	model: row.modelId,
	modelOwner: row.modelOwnerKind === "platform" ? "platform" : "organization",
	...(row.upstream === null ? {} : { upstream: row.upstream }),
	...(row.reasoningEfforts === null
		? {}
		: { reasoningEfforts: decodeOptions(row.reasoningEfforts) }),
	...(row.serviceTiers === null
		? {}
		: { serviceTiers: decodeOptions(row.serviceTiers) }),
	...(row.contextWindow === null ? {} : { contextWindow: row.contextWindow }),
	...(row.maxOutputTokens === null
		? {}
		: { maxOutputTokens: row.maxOutputTokens }),
})

const linkRows = (
	provider: { readonly id: string; readonly owner: Owner },
	links: ReadonlyArray<ModelProvidersApi.ProviderModel>,
): Array<LinkRow> =>
	links.map((item, position) => {
		const owner = ownerColumns(linkedOwner({ provider, link: item }))
		return {
			providerId: provider.id,
			modelOwnerKind: owner.ownerKind,
			modelOwnerId: owner.ownerId,
			modelId: item.model,
			position,
			upstream: item.upstream ?? null,
			reasoningEfforts:
				item.reasoningEfforts === undefined
					? null
					: JSON.stringify(item.reasoningEfforts),
			serviceTiers:
				item.serviceTiers === undefined
					? null
					: JSON.stringify(item.serviceTiers),
			contextWindow: item.contextWindow ?? null,
			maxOutputTokens: item.maxOutputTokens ?? null,
		}
	})

const stored = (
	row: typeof modelProviders.$inferSelect,
	links: ReadonlyArray<LinkRow>,
): Stored => ({
	id: row.id,
	owner: ownerOf(row),
	kind: decodeKind(row.kind),
	name: row.name,
	endpoint: row.endpoint,
	apiKey: row.apiKey,
	apiKeyHint: row.apiKeyHint,
	models: links.map(link),
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

type Database = Effect.Success<ReturnType<typeof makeWithDefaults>>
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
/** A database or a transaction. Both can read. */
type Reader = Pick<Transaction, "select">

type KnownError =
	| ModelProvidersApi.ModelNotFound
	| ModelProvidersApi.ModelProviderNotFound
	| ModelProvidersApi.ModelProviderConflict
	| ModelProvidersApi.ModelProviderInvalid
const isKnown = (error: unknown): error is KnownError =>
	error instanceof ModelProvidersApi.ModelNotFound ||
	error instanceof ModelProvidersApi.ModelProviderNotFound ||
	error instanceof ModelProvidersApi.ModelProviderConflict ||
	error instanceof ModelProvidersApi.ModelProviderInvalid

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
	/** Adds the links to each provider row. */
	const withLinks = (
		rows: ReadonlyArray<typeof modelProviders.$inferSelect>,
		client: Reader = db,
	) =>
		Effect.gen(function* () {
			if (rows.length === 0) return []
			const links = yield* client
				.select()
				.from(providerModels)
				.where(
					inArray(
						providerModels.providerId,
						rows.map((row) => row.id),
					),
				)
				.orderBy(asc(providerModels.position))
			return rows.map((row) =>
				stored(
					row,
					links.filter((item) => item.providerId === row.id),
				),
			)
		})
	const get = (owner: Owner, id: string) =>
		db
			.select()
			.from(modelProviders)
			.where(where(owner, id))
			.pipe(
				Effect.flatMap((rows) => withLinks(rows)),
				Effect.map((list) => Option.fromNullishOr(list[0])),
				Effect.mapError(unavailable),
			)
	const notFound = (id: string) =>
		ModelProvidersApi.ModelProviderNotFound.make({ providerId: id })
	/**
	 * A provider of the platform links only models of the platform. A provider
	 * of an organization links its own models and the shared models that the
	 * organization may use.
	 */
	const checkLinks = (
		client: Reader,
		owner: Owner,
		links: ReadonlyArray<ModelProvidersApi.ProviderModel>,
	) =>
		Effect.gen(function* () {
			for (const item of links) {
				if (owner.kind === "platform" && item.modelOwner !== "platform")
					return yield* ModelProvidersApi.ModelProviderInvalid.make({
						message:
							"A provider of the platform can link only models of the platform.",
					})
				const columns = ownerColumns(
					linkedOwner({ provider: { owner }, link: item }),
				)
				const [row] = yield* client
					.select()
					.from(models)
					.where(
						and(
							eq(models.ownerKind, columns.ownerKind),
							eq(models.ownerId, columns.ownerId),
							eq(models.id, item.model),
						),
					)
				const usable =
					row !== undefined &&
					(owner.kind === "platform" ||
						usableBy({
							provider: {
								owner: ownerOf(row),
								availability:
									row.availability === null
										? null
										: decodeAvailability(row.availability),
							},
							organizationId: owner.id,
						}))
				if (!usable)
					return yield* ModelProvidersApi.ModelNotFound.make({
						modelId: item.model,
					})
			}
		})
	/** Keep the errors of the API, and turn database errors into one error. */
	const known = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.mapError((error) => (isKnown(error) ? error : unavailable())),
		)

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
					Effect.flatMap((rows) => withLinks(rows)),
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
					Effect.flatMap((rows) => withLinks(rows)),
					Effect.map((list) =>
						list.filter((provider) => usableBy({ provider, organizationId })),
					),
					Effect.mapError(unavailable),
				),
		create: (owner, input) =>
			known(
				Effect.gen(function* () {
					const endpoint = input.endpoint ?? null
					yield* checkEndpoint(input.kind, endpoint)
					const now = yield* Clock.currentTimeMillis
					const id = "prov_" + randomUUID().replaceAll("-", "")
					const apiKey = yield* secrets.seal(input.apiKey, binding(id))
					const row = {
						id,
						...ownerColumns(owner),
						kind: input.kind,
						name: input.name.trim(),
						endpoint,
						apiKey,
						apiKeyHint: hint(input.apiKey),
						availability:
							owner.kind === "platform"
								? JSON.stringify(input.availability)
								: null,
						version: 1,
						createdAt: now,
						updatedAt: now,
					}
					const links = linkRows({ id, owner }, input.models)
					yield* db.transaction((tx) =>
						Effect.gen(function* () {
							yield* checkLinks(tx, owner, input.models)
							yield* tx.insert(modelProviders).values(row)
							if (links.length > 0)
								yield* tx.insert(providerModels).values(links)
						}),
					)
					return stored(row, links)
				}),
			),
		update: (owner, id, patch) =>
			known(
				db.transaction((tx) =>
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
						const endpoint =
							patch.endpoint === undefined ? row.endpoint : patch.endpoint
						yield* checkEndpoint(decodeKind(row.kind), endpoint)
						const now = yield* Clock.currentTimeMillis
						const key =
							patch.apiKey === undefined
								? undefined
								: {
										apiKey: yield* secrets.seal(patch.apiKey, binding(id)),
										apiKeyHint: hint(patch.apiKey),
									}
						if (patch.models !== undefined) {
							yield* checkLinks(tx, owner, patch.models)
							yield* tx
								.delete(providerModels)
								.where(eq(providerModels.providerId, id))
							const links = linkRows({ id, owner }, patch.models)
							if (links.length > 0)
								yield* tx.insert(providerModels).values(links)
						}
						const [updated] = yield* tx
							.update(modelProviders)
							.set({
								...(patch.name === undefined
									? {}
									: { name: patch.name.trim() }),
								endpoint,
								...key,
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
						const [result] = yield* withLinks([updated], tx)
						if (result === undefined) return yield* notFound(id)
						return result
					}),
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
