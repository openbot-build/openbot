import { Model, Provider } from "@openbot-build/core"
import { Models as ModelsModel } from "@openbot-build/domain"

import {
	Array as Arr,
	Clock,
	Crypto,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { and, asc, eq, inArray, or } from "drizzle-orm"
import * as Failures from "../errors/Failures.ts"
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
import * as Db from "../database/Database.ts"

const Options = Schema.fromJsonString(Schema.Array(Schema.String))
const AvailabilityJson = Schema.fromJsonString(ModelsModel.Availability)
const decodeOptions = Schema.decodeUnknownEffect(Options)
const decodeAvailability = Schema.decodeUnknownEffect(AvailabilityJson)
const decodeKind = Schema.decodeUnknownEffect(ModelsModel.ProviderKind)
const decodeType = Schema.decodeUnknownEffect(ModelsModel.ModelType)
/** The values have their types already, so they always encode. */
const encodeOptions = (options: typeof Options.Type) =>
	Schema.encodeEffect(Options)(options).pipe(Effect.orDie)
const encodeAvailability = (availability: typeof AvailabilityJson.Type) =>
	Schema.encodeEffect(AvailabilityJson)(availability).pipe(Effect.orDie)

/** Turns an inside failure into one public error. The log keeps the reason. */
const unavailable = (message: string) =>
	Failures.replace(message, () =>
		ModelsModel.ModelProvidersUnavailable.make({}),
	)

/** A stored value that does not decode makes the store unavailable. */
const storedValue =
	(what: string) =>
	<A>(decode: Effect.Effect<A, Schema.SchemaError>) =>
		decode.pipe(unavailable(`A stored ${what} has a bad value`))
const providerValue = storedValue("model provider")
const modelValue = storedValue("model")

const binding = (id: string) => "openbot_model_providers:" + id + ":api_key"

type LinkRow = typeof providerModels.$inferSelect

const link = (
	row: LinkRow,
): Effect.Effect<ModelsModel.ProviderModel, Schema.SchemaError> =>
	Effect.gen(function* () {
		return {
			model: Model.Id.make(row.modelId),
			modelOwner:
				row.modelOwnerKind === "platform" ? "platform" : "organization",
			...(row.upstream === null ? {} : { upstream: row.upstream }),
			...(row.reasoningEfforts === null
				? {}
				: { reasoningEfforts: yield* decodeOptions(row.reasoningEfforts) }),
			...(row.serviceTiers === null
				? {}
				: { serviceTiers: yield* decodeOptions(row.serviceTiers) }),
			...(row.contextWindow === null
				? {}
				: { contextWindow: row.contextWindow }),
			...(row.maxOutputTokens === null
				? {}
				: { maxOutputTokens: row.maxOutputTokens }),
		}
	})

const linkRows = (
	provider: { readonly id: string; readonly owner: Owner },
	links: ReadonlyArray<ModelsModel.ProviderModel>,
): Effect.Effect<Array<LinkRow>> =>
	Effect.forEach(links, (item, position) =>
		Effect.gen(function* () {
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
						: yield* encodeOptions(item.reasoningEfforts),
				serviceTiers:
					item.serviceTiers === undefined
						? null
						: yield* encodeOptions(item.serviceTiers),
				contextWindow: item.contextWindow ?? null,
				maxOutputTokens: item.maxOutputTokens ?? null,
			}
		}),
	)

const stored = (
	row: typeof modelProviders.$inferSelect,
	links: ReadonlyArray<LinkRow>,
): Effect.Effect<Stored, ModelsModel.ModelProvidersUnavailable> =>
	Effect.gen(function* () {
		return {
			id: row.id,
			owner: ownerOf(row),
			kind: yield* decodeKind(row.kind),
			name: row.name,
			endpoint: row.endpoint,
			apiKey: row.apiKey,
			apiKeyHint: row.apiKeyHint,
			oauth: row.oauth,
			models: yield* Effect.forEach(links, link),
			availability:
				row.availability === null
					? null
					: yield* decodeAvailability(row.availability),
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}
	}).pipe(providerValue)

/**
 * An `openai-compat` provider has no default address. A `typesafe` provider
 * has none yet either, because TypeSafe has not published one official address.
 */
const checkEndpoint = (
	kind: ModelsModel.ProviderKind,
	endpoint: string | null,
) =>
	kind === "chatgpt" && endpoint !== null
		? Effect.fail(
				ModelsModel.ModelProviderInvalid.make({
					message: "A ChatGPT provider uses the OpenAI public API address.",
				}),
			)
		: (kind === "openai-compat" || kind === "typesafe") && endpoint === null
			? Effect.fail(
					ModelsModel.ModelProviderInvalid.make({
						message: `An ${kind} provider needs an endpoint.`,
					}),
				)
			: Effect.void

/** The model types that each provider kind can serve. */
const servesType = (
	kind: ModelsModel.ProviderKind,
	type: ModelsModel.ModelType,
) => {
	switch (kind) {
		// OpenAI also serves Live models through its Realtime API.
		case "openai":
			return type === "language" || type === "live"
		case "chatgpt":
		case "anthropic":
			return type === "language"
		case "typesafe":
			return type === "decision"
		// A gateway, such as OpenRouter or LiteLLM, can serve both.
		case "openai-compat":
			return true
	}
}

type Database = Db.Database
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
/** A database or a transaction. Both can read. */
type Reader = Pick<Transaction, "select">

/** The errors that go to the client as they are. A `ModelProvidersUnavailable` here is in the log already. */
const Known = Schema.Union([
	ModelsModel.ModelNotFound,
	ModelsModel.ModelProviderNotFound,
	ModelsModel.ModelProviderConflict,
	ModelsModel.ModelProviderInvalid,
	ModelsModel.ModelProvidersUnavailable,
])
const isKnown = Schema.is(Known)

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const newId = crypto.randomUUIDv7().pipe(
		Effect.orDie,
		Effect.map((uuid) => "prov_" + Str.replaceAll("-", "")(uuid)),
	)
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
						Arr.map(rows, (row) => row.id),
					),
				)
				.orderBy(asc(providerModels.position))
				.pipe(unavailable("Could not read the models of the providers"))
			return yield* Effect.forEach(rows, (row) =>
				stored(
					row,
					Arr.filter(links, (item) => item.providerId === row.id),
				),
			)
		})
	const get = (owner: Owner, id: string) =>
		db
			.select()
			.from(modelProviders)
			.where(where(owner, id))
			.pipe(
				unavailable("Could not read the model provider"),
				Effect.flatMap((rows) => withLinks(rows)),
				Effect.map((list) => Option.fromNullishOr(list[0])),
			)
	/**
	 * A provider of the platform links only models of the platform. A provider
	 * of an organization links its own models and the shared models that the
	 * organization may use. The kind of the provider must serve the type of
	 * each model.
	 */
	const checkLinks = (
		client: Reader,
		owner: Owner,
		kind: ModelsModel.ProviderKind,
		links: ReadonlyArray<ModelsModel.ProviderModel>,
	) =>
		Effect.gen(function* () {
			for (const item of links) {
				if (owner.kind === "platform" && item.modelOwner !== "platform")
					return yield* ModelsModel.ModelProviderInvalid.make({
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
										: yield* modelValue(decodeAvailability(row.availability)),
							},
							organizationId: owner.id,
						}))
				if (!usable)
					return yield* ModelsModel.ModelNotFound.make({
						modelId: item.model,
					})
				const type = yield* modelValue(decodeType(row.type))
				if (!servesType(kind, type))
					return yield* ModelsModel.ModelProviderInvalid.make({
						message: `A ${kind} provider cannot link the ${type} model ${item.model}.`,
					})
			}
		})
	/** Keep the errors of the API, and turn database errors into one error. */
	const known = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.catchIf(
			effect,
			(error): error is Exclude<E, typeof Known.Type> => !isKnown(error),
			(error) =>
				Effect.fail(error).pipe(
					unavailable("Could not change the model provider"),
				),
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
					unavailable("Could not list the model providers"),
					Effect.flatMap((rows) => withLinks(rows)),
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
					unavailable("Could not list the model providers"),
					Effect.flatMap((rows) => withLinks(rows)),
					Effect.map((list) =>
						Arr.filter(list, (provider) =>
							usableBy({ provider, organizationId }),
						),
					),
				),
		create: (owner, input) =>
			known(
				Effect.gen(function* () {
					const endpoint = input.endpoint ?? null
					yield* checkEndpoint(input.kind, endpoint)
					const now = yield* Clock.currentTimeMillis
					const id = yield* newId
					if ((input.kind === "chatgpt") !== (input.apiKey === undefined))
						return yield* ModelsModel.ModelProviderInvalid.make({
							message:
								"ChatGPT needs browser sign-in. Other providers need an API key.",
						})
					const apiKey =
						input.apiKey === undefined
							? null
							: yield* secrets.seal(Redacted.value(input.apiKey), binding(id))
					const row = {
						id,
						...ownerColumns(owner),
						kind: input.kind,
						name: Str.trim(input.name),
						endpoint,
						apiKey,
						apiKeyHint:
							input.apiKey === undefined
								? null
								: hint(Redacted.value(input.apiKey)),
						oauth:
							input.kind === "chatgpt"
								? { connected: false, loginRequired: false }
								: null,
						availability:
							owner.kind === "platform"
								? yield* encodeAvailability(input.availability)
								: null,
						version: 1,
						createdAt: now,
						updatedAt: now,
					}
					const links = yield* linkRows({ id, owner }, input.models)
					yield* db.transaction((tx) =>
						Effect.gen(function* () {
							yield* checkLinks(tx, owner, input.kind, input.models)
							yield* tx.insert(modelProviders).values(row)
							if (links.length > 0)
								yield* tx.insert(providerModels).values(links)
						}),
					)
					return yield* stored(row, links)
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
						if (row === undefined)
							return yield* ModelsModel.ModelProviderNotFound.make({
								providerId: Provider.Id.make(id),
							})
						if (row.version !== patch.expectedVersion)
							return yield* ModelsModel.ModelProviderConflict.make({
								version: row.version,
							})
						const kind = yield* providerValue(decodeKind(row.kind))
						if (kind === "chatgpt" && patch.apiKey !== undefined)
							return yield* ModelsModel.ModelProviderInvalid.make({
								message:
									"A ChatGPT provider uses browser sign-in, not an API key.",
							})
						const endpoint =
							patch.endpoint === undefined ? row.endpoint : patch.endpoint
						yield* checkEndpoint(kind, endpoint)
						const now = yield* Clock.currentTimeMillis
						const key =
							patch.apiKey === undefined
								? undefined
								: {
										apiKey: yield* secrets.seal(
											Redacted.value(patch.apiKey),
											binding(id),
										),
										apiKeyHint: hint(Redacted.value(patch.apiKey)),
									}
						if (patch.models !== undefined) {
							yield* checkLinks(tx, owner, kind, patch.models)
							yield* tx
								.delete(providerModels)
								.where(eq(providerModels.providerId, id))
							const links = yield* linkRows({ id, owner }, patch.models)
							if (links.length > 0)
								yield* tx.insert(providerModels).values(links)
						}
						const [updated] = yield* tx
							.update(modelProviders)
							.set({
								...(patch.name === undefined
									? {}
									: { name: Str.trim(patch.name) }),
								endpoint,
								...key,
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
							return yield* ModelsModel.ModelProviderNotFound.make({
								providerId: Provider.Id.make(id),
							})
						const [result] = yield* withLinks([updated], tx)
						if (result === undefined)
							return yield* ModelsModel.ModelProviderNotFound.make({
								providerId: Provider.Id.make(id),
							})
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
					unavailable("Could not delete the model provider"),
					Effect.flatMap((rows) =>
						rows.length === 0
							? Effect.fail(
									ModelsModel.ModelProviderNotFound.make({
										providerId: Provider.Id.make(id),
									}),
								)
							: Effect.void,
					),
				),
		openKey: (provider) =>
			provider.apiKey === null
				? Effect.fail(ModelsModel.ModelProvidersUnavailable.make({}))
				: secrets
						.open(provider.apiKey, binding(provider.id))
						.pipe(
							Effect.map(Redacted.make),
							unavailable("Could not open the key of the model provider"),
						),
	})
})

export const layer = Layer.effect(ModelProviders, make)
