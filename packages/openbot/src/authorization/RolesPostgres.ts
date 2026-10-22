import { OrganizationApi, Permissions } from "@openbot-build/api"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { roles } from "../database/Schema.ts"
import { builtin, Roles, RolesUnavailable } from "./Roles.ts"
import * as Db from "../database/Database.ts"

const PolicyList = Schema.fromJsonString(Permissions.Policies)
const decodePolicies = Schema.decodeUnknownSync(PolicyList)

const view = (row: typeof roles.$inferSelect): Permissions.Role => ({
	id: row.id,
	name: row.name,
	description: row.description,
	builtin: false,
	policies: decodePolicies(row.policies),
})

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const unavailable = () => RolesUnavailable.make({})
	const where = (organizationId: string, roleId: string) =>
		and(eq(roles.organizationId, organizationId), eq(roles.id, roleId))
	const readOnly = (roleId: string) =>
		Permissions.isBuiltinRole(roleId)
			? Effect.fail(OrganizationApi.RoleReadOnly.make({ roleId }))
			: Effect.void

	const custom = (organizationId: string) =>
		db
			.select()
			.from(roles)
			.where(eq(roles.organizationId, organizationId))
			.orderBy(asc(roles.createdAt))
			.pipe(
				Effect.map((rows) => rows.map(view)),
				Effect.mapError(unavailable),
			)

	return Roles.of({
		list: (organizationId) =>
			Effect.map(custom(organizationId), (custom) => [...builtin, ...custom]),
		get: (organizationId, roleId) =>
			Permissions.isBuiltinRole(roleId)
				? Effect.succeed(
						Option.fromNullishOr(builtin.find((role) => role.id === roleId)),
					)
				: db
						.select()
						.from(roles)
						.where(where(organizationId, roleId))
						.pipe(
							Effect.map((rows) =>
								Option.map(Option.fromNullishOr(rows[0]), view),
							),
							Effect.mapError(unavailable),
						),
		create: (organizationId, input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const row = {
					organizationId,
					id: "role_" + randomUUID().replaceAll("-", ""),
					name: input.name.trim(),
					description: input.description,
					policies: JSON.stringify(input.policies),
					createdAt: now,
					updatedAt: now,
				}
				yield* db.insert(roles).values(row).pipe(Effect.mapError(unavailable))
				return view(row)
			}),
		update: (organizationId, roleId, patch) =>
			Effect.gen(function* () {
				yield* readOnly(roleId)
				const now = yield* Clock.currentTimeMillis
				const [row] = yield* db
					.update(roles)
					.set({
						...(patch.name === undefined ? {} : { name: patch.name.trim() }),
						...(patch.description === undefined
							? {}
							: { description: patch.description }),
						...(patch.policies === undefined
							? {}
							: { policies: JSON.stringify(patch.policies) }),
						updatedAt: now,
					})
					.where(where(organizationId, roleId))
					.returning()
					.pipe(Effect.mapError(unavailable))
				if (row === undefined)
					return yield* OrganizationApi.RoleNotFound.make({ roleId })
				return view(row)
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
					return yield* OrganizationApi.RoleNotFound.make({ roleId })
			}),
	})
})

export const layer = Layer.effect(Roles, make)
