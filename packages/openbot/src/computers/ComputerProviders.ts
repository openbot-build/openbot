import { Redacted } from "effect"
import { Computers as ComputerData } from "@openbot-build/domain"

import { type Caller, type ExecutionIdentity } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import * as Failures from "../errors/Failures.ts"
import * as Check from "../authorization/Check.ts"
import { computerProviderResource } from "../authorization/Resources.ts"
import { toWhere } from "../authorization/Sql.ts"
import * as Db from "../database/Database.ts"
import { computerProviders, computers } from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"

type ComputerProvider = ComputerData.ComputerProvider
type Credentials = ComputerData.ComputerProviderCredentials

/** The opened secret holds JSON that only this file writes, from a checked request. */
const CredentialsJson = Schema.fromJsonString(
	ComputerData.ComputerProviderCredentials,
)
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsJson)
const encodeCredentials = Schema.encodeEffect(CredentialsJson)

/** The fields of the credentials that are not secret. The key is always empty here. */
const Plain = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("e2b"),
		apiKey: Schema.String,
		apiUrl: Schema.optionalKey(Schema.String),
		sandboxDomain: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("daytona"),
		apiKey: Schema.String,
		apiUrl: Schema.optionalKey(Schema.String),
		target: Schema.optionalKey(Schema.String),
	}),
])
type Plain = typeof Plain.Type

const decodeId = Schema.decodeUnknownEffect(ComputerData.ComputerProviderId)
const decodeKind = Schema.decodeUnknownEffect(ComputerData.ComputerProviderKind)

/** The hints column holds JSON that only this file writes. */
const HintsJson = Schema.fromJsonString(
	Schema.Struct({ apiKey: Schema.NullOr(Schema.String), plain: Plain }),
)
const decodeHints = Schema.decodeUnknownEffect(HintsJson)
const encodeHints = Schema.encodeEffect(HintsJson)
type Row = typeof computerProviders.$inferSelect

export type Failure =
	| ComputerData.ComputerProviderInUse
	| ComputerData.ComputerProviderNotFound
	| ComputerData.ComputerConflict
	| ComputerData.ComputerInvalid
	| ComputerData.ComputerProviderFailed
	| ComputerData.ComputersUnavailable
	| Check.Errors

const binding = (id: string) => `openbot_computer_providers:${id}:credentials`

/** The last characters of the API key. The other fields are not secret. */
const hintsOf = (credentials: Credentials) => ({
	apiKey: hint(Redacted.value(credentials.apiKey)),
})

const viewOf = (
	credentials: Plain,
	apiKey: string | null,
): ComputerData.ComputerProviderCredentialsView => {
	const key = { set: true, hint: apiKey }
	switch (credentials.kind) {
		case "e2b":
			return {
				kind: "e2b",
				apiKey: key,
				apiUrl: credentials.apiUrl ?? null,
				sandboxDomain: credentials.sandboxDomain ?? null,
			}
		case "daytona":
			return {
				kind: "daytona",
				apiKey: key,
				apiUrl: credentials.apiUrl ?? null,
				target: credentials.target ?? null,
			}
	}
}

/** A row with a bad value is a broken store. The log keeps the cause. */
const fromRow = (
	row: Row,
): Effect.Effect<ComputerProvider, ComputerData.ComputersUnavailable> =>
	Effect.gen(function* () {
		const stored = yield* decodeHints(row.hints)
		return {
			id: yield* decodeId(row.id),
			kind: yield* decodeKind(row.kind),
			name: row.name,
			owner:
				row.ownerUserId === null
					? { _tag: "Organization" }
					: { _tag: "Member", userId: row.ownerUserId },
			credentials: viewOf(stored.plain, stored.apiKey),
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		} satisfies ComputerProvider
	}).pipe(
		Failures.replace("A stored Computer provider has a bad value", () =>
			ComputerData.ComputersUnavailable.make({}),
		),
	)

/** The accounts at Computer providers. The keys are sealed and never come out. */
export class ComputerProviders extends Context.Service<
	ComputerProviders,
	{
		readonly list: (
			identity: ExecutionIdentity,
		) => Effect.Effect<ReadonlyArray<ComputerProvider>, Failure>
		/** Reads a provider that the caller may read, and also use or change when asked. */
		readonly get: (
			caller: Caller,
			id: string,
			action?: "read" | "use" | "write",
		) => Effect.Effect<ComputerProvider, Failure>
		readonly create: (
			caller: Caller,
			input: ComputerData.CreateComputerProviderRequest,
			verify: (credentials: Credentials) => Effect.Effect<void, Failure>,
		) => Effect.Effect<ComputerProvider, Failure>
		readonly update: (
			caller: Caller,
			id: string,
			input: ComputerData.UpdateComputerProviderRequest,
			verify: (credentials: Credentials) => Effect.Effect<void, Failure>,
		) => Effect.Effect<ComputerProvider, Failure>
		/** Fails while Computers still use the provider. */
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure>
		/** The secrets of a provider, for its driver. It checks no permission. */
		readonly credentials: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			{ readonly credentials: Credentials; readonly version: number },
			ComputerData.ComputerProviderNotFound | ComputerData.ComputersUnavailable
		>
	}
>()("@openbot-build/openbot/computers/ComputerProviders") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const checks = yield* Check.make
	const { check, guard } = checks
	const stored = Failures.replace("The Computer provider store failed", () =>
		ComputerData.ComputersUnavailable.make({}),
	)
	const where = (organizationId: string, id: string) =>
		and(
			eq(computerProviders.organizationId, organizationId),
			eq(computerProviders.id, id),
		)
	const row = (organizationId: string, id: string) =>
		stored(
			db.select().from(computerProviders).where(where(organizationId, id)),
		).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
	const seal = (id: string, credentials: Credentials) =>
		Effect.gen(function* () {
			// The credentials passed the request schema, so they always encode.
			const json = yield* encodeCredentials(credentials).pipe(Effect.orDie)
			const sealed = yield* stored(secrets.seal(json, binding(id)))
			return {
				credentials: sealed,
				hints: yield* encodeHints({
					...hintsOf(credentials),
					plain: { ...credentials, apiKey: "" },
				}).pipe(Effect.orDie),
			}
		})
	/** A caller who cannot read a provider does not learn that it exists. */
	const access = (
		caller: Caller,
		id: string,
		action: "read" | "use" | "write",
	) =>
		Effect.gen(function* () {
			const found = yield* row(caller.organizationId, id)
			if (Option.isNone(found))
				return yield* ComputerData.ComputerProviderNotFound.make({ id })
			const provider = yield* fromRow(found.value)
			yield* guard(
				caller,
				{
					action,
					resource: computerProviderResource({
						...provider,
						organizationId: caller.organizationId,
					}),
				},
				{
					hide: () => ComputerData.ComputerProviderNotFound.make({ id }),
				},
			)
			return { provider, row: found.value }
		})
	return ComputerProviders.of({
		list: (identity) =>
			Effect.gen(function* () {
				const { organizationId } = identity.owner
				const readable = yield* Check.executionFilter(checks, identity, {
					action: "read",
					kind: "ComputerProvider",
					within: ($) => $.eq("organizationId", organizationId),
				}).pipe(
					Effect.flatMap((condition) =>
						toWhere(condition, {
							organizationId: computerProviders.organizationId,
							ownerUserId: computerProviders.ownerUserId,
							id: computerProviders.id,
						}),
					),
				)
				const rows = yield* stored(
					db
						.select()
						.from(computerProviders)
						.where(
							and(
								eq(computerProviders.organizationId, organizationId),
								readable,
							),
						)
						.orderBy(computerProviders.createdAt),
				)
				return yield* Effect.forEach(rows, fromRow)
			}),
		get: (caller, id, action = "read") =>
			Effect.map(access(caller, id, action), (found) => found.provider),
		create: (caller, input, verify) =>
			Effect.gen(function* () {
				const userId = input.shared === true ? null : caller.userId
				yield* check(caller, {
					action: "write",
					kind: "ComputerProvider",
					within: ($) =>
						$.and(
							$.eq("organizationId", caller.organizationId),
							$.eq("ownerUserId", userId),
						),
				})
				yield* verify(input.credentials)
				const now = yield* Clock.currentTimeMillis
				const id =
					"cpp_" + Hex.encode(yield* crypto.randomBytes(16).pipe(Effect.orDie))
				const sealed = yield* seal(id, input.credentials)
				const created = Arr.head(
					yield* stored(
						db
							.insert(computerProviders)
							.values({
								organizationId: caller.organizationId,
								id,
								ownerUserId: userId,
								kind: input.credentials.kind,
								name: input.name,
								...sealed,
								version: 0,
								createdAt: now,
								updatedAt: now,
							})
							.returning(),
					),
				)
				if (Option.isNone(created))
					return yield* Effect.die("An insert gave back no row")
				return yield* fromRow(created.value)
			}),
		update: (caller, id, input, verify) =>
			Effect.gen(function* () {
				const { provider } = yield* access(caller, id, "write")
				if (input.expectedVersion !== provider.version)
					return yield* ComputerData.ComputerConflict.make({
						version: provider.version,
					})
				if (
					input.credentials !== undefined &&
					input.credentials.kind !== provider.kind
				)
					return yield* ComputerData.ComputerInvalid.make({
						message: "The kind of a Computer provider cannot change.",
					})
				if (input.credentials !== undefined) yield* verify(input.credentials)
				const sealed =
					input.credentials === undefined
						? {}
						: yield* seal(id, input.credentials)
				const now = yield* Clock.currentTimeMillis
				const changed = yield* stored(
					db
						.update(computerProviders)
						.set({
							...(input.name === undefined ? {} : { name: input.name }),
							...sealed,
							version: provider.version + 1,
							updatedAt: now,
						})
						.where(
							and(
								where(caller.organizationId, id),
								eq(computerProviders.version, provider.version),
							),
						)
						.returning(),
				)
				const next = changed[0]
				if (next === undefined)
					return yield* ComputerData.ComputerConflict.make({
						version: provider.version,
					})
				return yield* fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "write")
				const used = yield* stored(
					db
						.select({ id: computers.id })
						.from(computers)
						.where(
							and(
								eq(computers.organizationId, caller.organizationId),
								eq(computers.providerId, id),
							),
						)
						.limit(1),
				)
				if (used.length > 0)
					return yield* ComputerData.ComputerProviderInUse.make({ id })
				yield* stored(
					db.delete(computerProviders).where(where(caller.organizationId, id)),
				)
			}),
		credentials: (organizationId, id) =>
			Effect.gen(function* () {
				const found = yield* row(organizationId, id)
				if (Option.isNone(found))
					return yield* ComputerData.ComputerProviderNotFound.make({ id })
				const json = yield* stored(
					secrets.open(found.value.credentials, binding(id)),
				)
				return {
					credentials: yield* stored(decodeCredentials(json)),
					version: found.value.version,
				}
			}),
	})
})
export const layer = Layer.effect(ComputerProviders, make)
