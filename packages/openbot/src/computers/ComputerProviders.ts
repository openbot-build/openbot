import { randomBytes } from "node:crypto"
import { type Caller, ComputersApi, Permissions } from "@openbot-build/api"
import { and, eq, isNull, or } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option } from "effect"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { can } from "../authorization/Check.ts"
import { computerKey, computerPlace } from "../authorization/Policy.ts"
import * as Db from "../database/Database.ts"
import { computerProviders, computers } from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"

type ComputerProvider = ComputersApi.ComputerProvider
type Credentials = ComputersApi.ComputerProviderCredentials
type Row = typeof computerProviders.$inferSelect

export const unavailable = () => ComputersApi.ComputersUnavailable.make({})
const notFound = (id: string) =>
	ComputersApi.ComputerProviderNotFound.make({ id })

export type Failure =
	| ComputersApi.ComputerProviderNotFound
	| ComputersApi.ComputerConflict
	| ComputersApi.ComputerInvalid
	| ComputersApi.ComputersUnavailable
	| Permissions.PermissionDenied
	| Permissions.AuthorizationUnavailable

const binding = (id: string) => `openbot_computer_providers:${id}:credentials`

/** The last characters of the API key. The other fields are not secret. */
const hintsOf = (credentials: Credentials) => ({
	apiKey: hint(credentials.apiKey),
})

const viewOf = (
	credentials: Credentials,
	apiKey: string | null,
): ComputersApi.ComputerProviderCredentialsView => {
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

/** The fields of the credentials without the key, so the API can show them. */
const plainOf = (credentials: Credentials): Credentials => ({
	...credentials,
	apiKey: "",
})

const fromRow = (row: Row): ComputerProvider => {
	const stored = JSON.parse(row.hints) as {
		readonly apiKey: string | null
		readonly plain: Credentials
	}
	return {
		id: ComputersApi.ComputerProviderId.make(row.id),
		kind: row.kind as ComputersApi.ComputerProviderKind,
		name: row.name,
		owner:
			row.ownerUserId === null
				? { _tag: "Organization" }
				: { _tag: "Member", userId: row.ownerUserId },
		credentials: viewOf(stored.plain, stored.apiKey),
		version: row.version,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

/** The accounts at Computer providers. The keys are sealed and never come out. */
export class ComputerProviders extends Context.Service<
	ComputerProviders,
	{
		readonly list: (
			caller: Caller,
		) => Effect.Effect<
			ReadonlyArray<ComputerProvider>,
			Failure,
			AuthorizationServices
		>
		/** Reads a provider that the caller may read, and also use or change when asked. */
		readonly get: (
			caller: Caller,
			id: string,
			permission?:
				| "computer_providers.read"
				| "computer_providers.use"
				| "computer_providers.write",
		) => Effect.Effect<ComputerProvider, Failure, AuthorizationServices>
		readonly create: (
			caller: Caller,
			input: ComputersApi.CreateComputerProviderRequest,
			verify: (credentials: Credentials) => Effect.Effect<void, Failure>,
		) => Effect.Effect<ComputerProvider, Failure, AuthorizationServices>
		readonly update: (
			caller: Caller,
			id: string,
			input: ComputersApi.UpdateComputerProviderRequest,
			verify: (credentials: Credentials) => Effect.Effect<void, Failure>,
		) => Effect.Effect<ComputerProvider, Failure, AuthorizationServices>
		/** Fails while Computers still use the provider. */
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure, AuthorizationServices>
		/** The secrets of a provider, for its driver. It checks no permission. */
		readonly credentials: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			{ readonly credentials: Credentials; readonly version: number },
			ComputersApi.ComputerProviderNotFound | ComputersApi.ComputersUnavailable
		>
	}
>()("@openbot-build/openbot/computers/ComputerProviders") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
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
			const sealed = yield* stored(
				secrets.seal(JSON.stringify(credentials), binding(id)),
			)
			return {
				credentials: sealed,
				hints: JSON.stringify({
					...hintsOf(credentials),
					plain: plainOf(credentials),
				}),
			}
		})
	const keyOf = (
		caller: Caller,
		provider: Pick<ComputerProvider, "id" | "owner">,
	) =>
		computerKey({
			organizationId: caller.organizationId,
			id: provider.id,
			owner: provider.owner,
			kind: "computer_provider",
		})
	/** A caller who cannot read a provider does not learn that it exists. */
	const access = (
		caller: Caller,
		id: string,
		permission: Permissions.PermissionGroupId,
	) =>
		Effect.gen(function* () {
			const found = yield* row(caller.organizationId, id)
			if (Option.isNone(found)) return yield* notFound(id)
			const provider = fromRow(found.value)
			const key = keyOf(caller, provider)
			if (!(yield* can({ caller, permission: "computer_providers.read", key })))
				return yield* notFound(id)
			if (
				permission !== "computer_providers.read" &&
				!(yield* can({ caller, permission, key }))
			)
				return yield* Permissions.PermissionDenied.make({
					permission,
					resource: key,
				})
			return { provider, row: found.value }
		})
	return ComputerProviders.of({
		list: (caller) =>
			Effect.gen(function* () {
				const readable: Array<string | null> = []
				for (const userId of [caller.userId, null])
					if (
						yield* can({
							caller,
							permission: "computer_providers.read",
							key: computerPlace({
								organizationId: caller.organizationId,
								userId,
								kind: "computer_provider",
							}),
						})
					)
						readable.push(userId)
				if (readable.length === 0) return []
				const rows = yield* stored(
					db
						.select()
						.from(computerProviders)
						.where(
							and(
								eq(computerProviders.organizationId, caller.organizationId),
								or(
									...readable.map((userId) =>
										userId === null
											? isNull(computerProviders.ownerUserId)
											: eq(computerProviders.ownerUserId, userId),
									),
								),
							),
						)
						.orderBy(computerProviders.createdAt),
				)
				return rows.map(fromRow)
			}),
		get: (caller, id, permission = "computer_providers.read") =>
			Effect.map(access(caller, id, permission), (found) => found.provider),
		create: (caller, input, verify) =>
			Effect.gen(function* () {
				const userId = input.shared === true ? null : caller.userId
				const place = computerPlace({
					organizationId: caller.organizationId,
					userId,
					kind: "computer_provider",
				})
				if (
					!(yield* can({
						caller,
						permission: "computer_providers.write",
						key: place,
					}))
				)
					return yield* Permissions.PermissionDenied.make({
						permission: "computer_providers.write",
						resource: place,
					})
				yield* verify(input.credentials)
				const now = yield* Clock.currentTimeMillis
				const id = "cpp_" + randomBytes(16).toString("hex")
				const sealed = yield* seal(id, input.credentials)
				yield* stored(
					db.insert(computerProviders).values({
						organizationId: caller.organizationId,
						id,
						ownerUserId: userId,
						kind: input.credentials.kind,
						name: input.name,
						...sealed,
						version: 0,
						createdAt: now,
						updatedAt: now,
					}),
				)
				const created = yield* row(caller.organizationId, id)
				return fromRow(Option.getOrThrow(created))
			}),
		update: (caller, id, input, verify) =>
			Effect.gen(function* () {
				const { provider } = yield* access(
					caller,
					id,
					"computer_providers.write",
				)
				if (input.expectedVersion !== provider.version)
					return yield* ComputersApi.ComputerConflict.make({
						version: provider.version,
					})
				if (
					input.credentials !== undefined &&
					input.credentials.kind !== provider.kind
				)
					return yield* ComputersApi.ComputerInvalid.make({
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
					return yield* ComputersApi.ComputerConflict.make({
						version: provider.version,
					})
				return fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "computer_providers.write")
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
					return yield* ComputersApi.ComputerInvalid.make({
						message: "Computers still use this provider. Delete them first.",
					})
				yield* stored(
					db.delete(computerProviders).where(where(caller.organizationId, id)),
				)
			}),
		credentials: (organizationId, id) =>
			Effect.gen(function* () {
				const found = yield* row(organizationId, id)
				if (Option.isNone(found)) return yield* notFound(id)
				const json = yield* stored(
					secrets.open(found.value.credentials, binding(id)),
				)
				return {
					credentials: JSON.parse(json) as Credentials,
					version: found.value.version,
				}
			}),
	})
})
export const layer = Layer.effect(ComputerProviders, make)
