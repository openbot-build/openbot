import {
	type AuthApi,
	OrganizationApi,
	Permissions,
	PlatformApi,
} from "@openbot-build/api"
import type { PgClient } from "@effect/sql-pg"
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect"
import { and, asc, eq, gt, isNotNull, like, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import {
	members,
	organizationDomains,
	organizations,
	tokens,
} from "../database/Schema.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { userKey } from "../authorization/Policy.ts"
import { Settings } from "../settings/Settings.ts"
import {
	type Account,
	domainOf,
	Organization,
	OrganizationUnavailable,
} from "./Organization.ts"
import * as Db from "../database/Database.ts"

const Roles = Schema.fromJsonString(OrganizationApi.Roles)
const PolicyList = Schema.fromJsonString(Permissions.Policies)
const decodeRoles = Schema.decodeUnknownSync(Roles)
const decodePolicies = Schema.decodeUnknownSync(PolicyList)
const decodeStatus = Schema.decodeUnknownSync(OrganizationApi.MemberStatus)
const decodeOrganizationStatus = Schema.decodeUnknownSync(
	OrganizationApi.OrganizationStatus,
)

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const organizationView = (
	row: typeof organizations.$inferSelect,
): OrganizationApi.Organization => ({
	id: row.id,
	name: row.name,
	status: decodeOrganizationStatus(row.status),
	createdAt: iso(row.createdAt),
})
const memberView = (
	row: typeof members.$inferSelect,
): OrganizationApi.Member => ({
	userId: row.userId,
	email: row.email,
	name: row.name,
	status: decodeStatus(row.status),
	roles: decodeRoles(row.roles),
	policies: decodePolicies(row.policies),
	joinedAt: iso(row.joinedAt),
})
const isActiveSuperAdministrator = (member: OrganizationApi.Member) =>
	member.status === "active" && member.roles.includes("super_administrator")
const newId = () => "org_" + randomUUID().replaceAll("-", "")

export const make: Effect.Effect<
	typeof Organization.Service,
	never,
	PgClient.PgClient | AuditLog | Settings
> = Effect.gen(function* () {
	const db = yield* Db.make
	type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
	const audit = yield* AuditLog
	const settings = yield* Settings
	const unavailable = () => OrganizationUnavailable.make({})

	/** Run one change to the members of an organization at a time, so the Super Administrator check stays true. */
	const lockMembers = (tx: Transaction, organizationId: string) =>
		tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${"openbot-members:" + organizationId}, 0))`,
		)
	const memberWhere = (organizationId: string, userId: string) =>
		and(eq(members.organizationId, organizationId), eq(members.userId, userId))

	const memberships = (userId: string) =>
		db
			.select({
				organizationId: organizations.id,
				name: organizations.name,
				organizationStatus: organizations.status,
				status: members.status,
				roles: members.roles,
			})
			.from(members)
			.innerJoin(organizations, eq(organizations.id, members.organizationId))
			.where(eq(members.userId, userId))
			.orderBy(asc(organizations.createdAt))
			.pipe(
				Effect.map((rows) =>
					rows.map((row): AuthApi.Membership => ({
						organizationId: row.organizationId,
						name: row.name,
						// A suspended organization suspends every membership in it.
						status:
							row.organizationStatus === "active"
								? decodeStatus(row.status)
								: "suspended",
						roles: decodeRoles(row.roles),
					})),
				),
				Effect.mapError(unavailable),
			)

	const recordJoin = (
		organizationId: string,
		account: Account,
		roles: ReadonlyArray<string>,
	) =>
		audit
			.record({
				organizationId,
				action: "member.joined",
				actor: { kind: "member", userId: account.id, organizationId },
				resource: userKey({ organizationId, userId: account.id }),
				details: { roles: [...roles] },
			})
			.pipe(Effect.mapError(unavailable))

	/** Adds a member. It does nothing when the account is already a member. */
	const join = (
		tx: Transaction,
		organizationId: string,
		account: Account,
		roles: ReadonlyArray<string>,
		now: number,
	) =>
		tx
			.insert(members)
			.values({
				organizationId,
				userId: account.id,
				email: account.email ?? null,
				name: account.name ?? null,
				status: "active",
				roles: JSON.stringify(roles),
				policies: JSON.stringify([]),
				joinedAt: now,
			})
			.onConflictDoNothing()
			.returning({ userId: members.userId })
			.pipe(Effect.map((rows) => rows.length > 0))

	/**
	 * Creates an organization and makes its owner the Super Administrator.
	 * With `firstOnly`, it does nothing when the owner already has an
	 * organization, so two first requests at the same time make only one.
	 */
	const createFor = (input: {
		readonly name: string
		readonly owner: Account
		readonly firstOnly: boolean
	}) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const row = {
				id: newId(),
				name: input.name.trim(),
				status: "active",
				createdAt: now,
			}
			const created = yield* db.transaction((tx) =>
				Effect.gen(function* () {
					if (input.firstOnly) {
						yield* tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtextextended(${"openbot-first-organization:" + input.owner.id}, 0))`,
						)
						const existing = yield* tx
							.select({ organizationId: members.organizationId })
							.from(members)
							.where(eq(members.userId, input.owner.id))
							.limit(1)
						if (existing.length > 0) return false
					}
					yield* tx.insert(organizations).values(row)
					yield* join(tx, row.id, input.owner, ["super_administrator"], now)
					return true
				}),
			)
			if (!created) return Option.none<OrganizationApi.Organization>()
			yield* audit
				.record({
					organizationId: row.id,
					action: "organization.created",
					actor: {
						kind: "member",
						userId: input.owner.id,
						organizationId: row.id,
					},
					resource: "openbot.org." + row.id,
					details: { name: row.name },
				})
				.pipe(Effect.mapError(unavailable))
			yield* recordJoin(row.id, input.owner, ["super_administrator"])
			return Option.some(organizationView(row))
		}).pipe(Effect.mapError(unavailable))
	const create = (input: { readonly name: string; readonly owner: Account }) =>
		createFor({ ...input, firstOnly: false }).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(unavailable()),
					onSome: Effect.succeed,
				}),
			),
		)

	/** The organization that verified the email domain of the account, if any. */
	const domainOrganization = (account: Account) =>
		Effect.gen(function* () {
			if (account.email === undefined || account.emailVerified !== true)
				return Option.none<string>()
			const [row] = yield* db
				.select({ organizationId: organizationDomains.organizationId })
				.from(organizationDomains)
				.where(
					and(
						eq(organizationDomains.domain, domainOf(account.email)),
						isNotNull(organizationDomains.verifiedAt),
					),
				)
				.pipe(Effect.mapError(unavailable))
			return Option.fromNullishOr(row?.organizationId)
		})

	const admit: (typeof Organization.Service)["admit"] = (account, options) =>
		Effect.gen(function* () {
			const before = yield* memberships(account.id)
			const target = Option.filter(
				options?.only === undefined
					? yield* domainOrganization(account)
					: Option.some(options.only),
				(id) => !before.some((member) => member.organizationId === id),
			)
			if (Option.isSome(target)) {
				const organizationId = target.value
				const current = yield* settings.organization(organizationId)
				if (options?.only !== undefined || current.document.joinByDomain) {
					const now = yield* Clock.currentTimeMillis
					const roles = current.document.defaultRoles
					const joined = yield* db
						.transaction((tx) =>
							Effect.gen(function* () {
								yield* lockMembers(tx, organizationId)
								return yield* join(tx, organizationId, account, roles, now)
							}),
						)
						.pipe(Effect.mapError(unavailable))
					if (joined) yield* recordJoin(organizationId, account, roles)
					return yield* memberships(account.id)
				}
			}
			if (before.length > 0) {
				// Keep the profile fresh. People see it in member lists.
				yield* db
					.update(members)
					.set({ email: account.email ?? null, name: account.name ?? null })
					.where(
						and(
							eq(members.userId, account.id),
							sql`(${members.email} IS DISTINCT FROM ${account.email ?? null} OR ${members.name} IS DISTINCT FROM ${account.name ?? null})`,
						),
					)
					.pipe(Effect.mapError(unavailable))
				return before
			}
			if (options?.only !== undefined) return before
			const platform = yield* settings.platform
			if (
				Option.exists(
					platform,
					(platform) => platform.document.organizationCreation === "anyone",
				)
			) {
				yield* createFor({ name: "Personal", owner: account, firstOnly: true })
				return yield* memberships(account.id)
			}
			return before
		}).pipe(
			Effect.mapError((error) =>
				error._tag === "OrganizationUnavailable" ? error : unavailable(),
			),
		)

	const findMember = (organizationId: string, userId: string) =>
		db
			.select()
			.from(members)
			.where(memberWhere(organizationId, userId))
			.pipe(
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), memberView),
				),
				Effect.mapError(unavailable),
			)
	const findOrganization = (organizationId: string) =>
		db
			.select()
			.from(organizations)
			.where(eq(organizations.id, organizationId))
			.pipe(
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), organizationView),
				),
				Effect.mapError(unavailable),
			)

	const updateMembers = <A, E>(
		organizationId: string,
		userId: string,
		change: (
			member: OrganizationApi.Member,
			tx: Transaction,
		) => Effect.Effect<A, E>,
		after: (member: OrganizationApi.Member) => OrganizationApi.Member | null,
	) =>
		db.transaction((tx) =>
			Effect.gen(function* () {
				yield* lockMembers(tx, organizationId)
				const rows = yield* tx
					.select()
					.from(members)
					.where(eq(members.organizationId, organizationId))
				const all = rows.map(memberView)
				const target = all.find((member) => member.userId === userId)
				if (target === undefined)
					return yield* OrganizationApi.MemberNotFound.make({ userId })
				const remaining = all.flatMap((member) => {
					if (member.userId !== userId) return [member]
					const next = after(member)
					return next === null ? [] : [next]
				})
				if (!remaining.some(isActiveSuperAdministrator))
					return yield* OrganizationApi.LastSuperAdministrator.make({})
				return yield* change(target, tx)
			}),
		)

	return Organization.of({
		admit,
		memberships,
		member: findMember,
		activeMember: (organizationId, userId) =>
			Effect.gen(function* () {
				const organization = yield* findOrganization(organizationId)
				if (
					!Option.exists(
						organization,
						(organization) => organization.status === "active",
					)
				)
					return Option.none()
				return Option.filter(
					yield* findMember(organizationId, userId),
					(member) => member.status === "active",
				)
			}),
		get: findOrganization,
		list: ({ after, limit }) =>
			db
				.select()
				.from(organizations)
				.where(after === undefined ? undefined : gt(organizations.id, after))
				.orderBy(asc(organizations.id))
				.limit(limit + 1)
				.pipe(
					Effect.map((rows) => {
						const page = rows.slice(0, limit).map(organizationView)
						return {
							items: page,
							next:
								rows.length > limit
									? (page[page.length - 1]?.id ?? null)
									: null,
						}
					}),
					Effect.mapError(unavailable),
				),
		create,
		update: (organizationId, patch) =>
			patch.name === undefined
				? findOrganization(organizationId).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.fail(unavailable()),
								onSome: Effect.succeed,
							}),
						),
					)
				: db
						.update(organizations)
						.set(patch.name === undefined ? {} : { name: patch.name.trim() })
						.where(eq(organizations.id, organizationId))
						.returning()
						.pipe(
							Effect.flatMap(([row]) =>
								row === undefined
									? Effect.fail(unavailable())
									: Effect.succeed(organizationView(row)),
							),
							Effect.mapError(unavailable),
						),
		setStatus: (organizationId, status) =>
			db
				.update(organizations)
				.set({ status })
				.where(eq(organizations.id, organizationId))
				.returning()
				.pipe(
					Effect.mapError(unavailable),
					Effect.flatMap(([row]) =>
						row === undefined
							? Effect.fail(
									PlatformApi.OrganizationNotFound.make({ organizationId }),
								)
							: Effect.succeed(organizationView(row)),
					),
				),
		listMembers: (organizationId, { after, limit }) =>
			db
				.select()
				.from(members)
				.where(
					and(
						eq(members.organizationId, organizationId),
						after === undefined ? undefined : gt(members.userId, after),
					),
				)
				.orderBy(asc(members.userId))
				.limit(limit + 1)
				.pipe(
					Effect.map((rows) => {
						const page = rows.slice(0, limit).map(memberView)
						return {
							items: page,
							next:
								rows.length > limit
									? (page[page.length - 1]?.userId ?? null)
									: null,
						}
					}),
					Effect.mapError(unavailable),
				),
		updateMember: (organizationId, userId, patch) => {
			const apply = (member: OrganizationApi.Member) => ({
				...member,
				...(patch.status === undefined ? {} : { status: patch.status }),
				...(patch.roles === undefined ? {} : { roles: patch.roles }),
				...(patch.policies === undefined ? {} : { policies: patch.policies }),
			})
			return updateMembers(
				organizationId,
				userId,
				(member, tx) =>
					tx
						.update(members)
						.set({
							status: apply(member).status,
							roles: JSON.stringify(apply(member).roles),
							policies: JSON.stringify(apply(member).policies),
						})
						.where(memberWhere(organizationId, userId))
						.pipe(Effect.as(apply(member))),
				apply,
			).pipe(
				Effect.mapError((error) =>
					error._tag === "MemberNotFound" ||
					error._tag === "LastSuperAdministrator"
						? error
						: unavailable(),
				),
			)
		},
		removeMember: (organizationId, userId) =>
			updateMembers(
				organizationId,
				userId,
				(_, tx) =>
					Effect.gen(function* () {
						yield* tx
							.delete(tokens)
							.where(
								and(
									eq(tokens.organizationId, organizationId),
									eq(tokens.userId, userId),
								),
							)
						yield* tx.delete(members).where(memberWhere(organizationId, userId))
					}),
				() => null,
			).pipe(
				Effect.mapError((error) =>
					error._tag === "MemberNotFound" ||
					error._tag === "LastSuperAdministrator"
						? error
						: unavailable(),
				),
			),
		roleInUse: (organizationId, roleId) =>
			Effect.gen(function* () {
				const current = yield* settings.organization(organizationId)
				if (current.document.defaultRoles.includes(roleId)) return true
				// Role IDs are plain letters, digits and underscores, so they are safe in a pattern.
				const rows = yield* db
					.select({ userId: members.userId })
					.from(members)
					.where(
						and(
							eq(members.organizationId, organizationId),
							like(members.roles, `%"${roleId}"%`),
						),
					)
					.limit(1)
				return rows.length > 0
			}).pipe(Effect.mapError(unavailable)),
	})
})

export const layer = Layer.effect(Organization, make)
