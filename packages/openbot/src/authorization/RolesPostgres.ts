import {
	Authorization,
	OrganizationApi,
	Roles as RolesApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
	String as Str,
} from "effect"
import { and, asc, eq } from "drizzle-orm"
import { roles } from "../database/Schema.ts"
import { builtin, Roles, RolesUnavailable } from "./Roles.ts"
import * as Db from "../database/Database.ts"

const PolicyJson = Schema.fromJsonString(Authorization.PolicySchema)
/** The policy column holds JSON that only this file writes, from a checked policy. */
const encodePolicy = (policy: typeof PolicyJson.Type) =>
	Schema.encodeEffect(PolicyJson)(policy).pipe(Effect.orDie)
const unavailable = (cause: unknown) => RolesUnavailable.make({ cause })

const view = (
	row: typeof roles.$inferSelect,
): Effect.Effect<RolesApi.Role, RolesUnavailable> =>
	Schema.decodeEffect(PolicyJson)(row.policy).pipe(
		Effect.mapError(unavailable),
		Effect.map((policy) => ({
			id: RolesApi.CustomRoleId.make(row.id),
			name: row.name,
			description: row.description,
			builtin: false,
			policy,
		})),
	)

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	const where = (organizationId: string, roleId: string) =>
		and(eq(roles.organizationId, organizationId), eq(roles.id, roleId))
	const readOnly = (roleId: string) =>
		RolesApi.isBuiltinRole(roleId)
			? Effect.fail(OrganizationApi.RoleReadOnly.make({ roleId }))
			: Effect.void

	const custom = (organizationId: string) =>
		db
			.select()
			.from(roles)
			.where(eq(roles.organizationId, organizationId))
			.orderBy(asc(roles.createdAt))
			.pipe(
				Effect.mapError(unavailable),
				Effect.flatMap((rows) => Effect.forEach(rows, view)),
			)

	return Roles.of({
		list: (organizationId) =>
			Effect.map(custom(organizationId), (custom) => [...builtin, ...custom]),
		get: (organizationId, roleId) =>
			RolesApi.isBuiltinRole(roleId)
				? Effect.succeed(Arr.findFirst(builtin, (role) => role.id === roleId))
				: db
						.select()
						.from(roles)
						.where(where(organizationId, roleId))
						.pipe(
							Effect.mapError(unavailable),
							Effect.flatMap((rows) =>
								Effect.transposeOption(Option.map(Arr.head(rows), view)),
							),
						),
		create: (organizationId, input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const uuid = yield* Effect.orDie(crypto.randomUUIDv4())
				const row = {
					organizationId,
					id: "role_" + Str.replaceAll("-", "")(uuid),
					name: Str.trim(input.name),
					description: input.description,
					policy: yield* encodePolicy(input.policy),
					createdAt: now,
					updatedAt: now,
				}
				yield* db.insert(roles).values(row).pipe(Effect.mapError(unavailable))
				return yield* view(row)
			}),
		update: (organizationId, roleId, patch) =>
			Effect.gen(function* () {
				yield* readOnly(roleId)
				const now = yield* Clock.currentTimeMillis
				const [row] = yield* db
					.update(roles)
					.set({
						...(patch.name === undefined ? {} : { name: Str.trim(patch.name) }),
						...(patch.description === undefined
							? {}
							: { description: patch.description }),
						...(patch.policy === undefined
							? {}
							: { policy: yield* encodePolicy(patch.policy) }),
						updatedAt: now,
					})
					.where(where(organizationId, roleId))
					.returning()
					.pipe(Effect.mapError(unavailable))
				if (row === undefined)
					return yield* OrganizationApi.RoleNotFound.make({
						roleId,
					})
				return yield* view(row)
			}),
		delete: (organizationId, roleId) =>
			Effect.gen(function* () {
				yield* readOnly(roleId)
				const deleted = yield* db
					.delete(roles)
					.where(where(organizationId, roleId))
					.returning({ id: roles.id })
					.pipe(Effect.mapError(unavailable))
				if (deleted.length === 0)
					return yield* OrganizationApi.RoleNotFound.make({
						roleId,
					})
			}),
	})
})

export const layer = Layer.effect(Roles, make)
