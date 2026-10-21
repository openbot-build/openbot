import { OrganizationApi, Permissions } from "@openbot-build/platform-api"
import type { PgClient } from "@effect/sql-pg"
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { randomUUID } from "node:crypto"
import { members, organizations, tokens } from "../database/Schema.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { userKey } from "../authorization/Policy.ts"
import {
	MembershipRejected,
	Organization,
	OrganizationUnavailable,
	type Options,
} from "./Organization.ts"

const Roles = Schema.fromJsonString(Schema.Array(Permissions.RoleId))
const Domains = Schema.fromJsonString(Schema.Array(Schema.String))
const PolicyList = Schema.fromJsonString(Permissions.Policies)
const decodeRoles = Schema.decodeUnknownSync(Roles)
const decodeDomains = Schema.decodeUnknownSync(Domains)
const decodePolicies = Schema.decodeUnknownSync(PolicyList)
const decodeStatus = Schema.decodeUnknownSync(OrganizationApi.MemberStatus)

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const organizationView = (
	row: typeof organizations.$inferSelect,
): OrganizationApi.Organization => ({
	id: row.id,
	name: row.name,
	allowedEmailDomains: decodeDomains(row.allowedEmailDomains),
	defaultRoles: decodeRoles(
		row.defaultRoles,
	) as OrganizationApi.Organization["defaultRoles"],
	createdAt: iso(row.createdAt),
})
const memberView = (
	row: typeof members.$inferSelect,
): OrganizationApi.Member => ({
	userId: row.userId,
	email: row.email,
	name: row.name,
	status: decodeStatus(row.status),
	roles: decodeRoles(row.roles) as OrganizationApi.Member["roles"],
	policies: decodePolicies(row.policies),
	joinedAt: iso(row.joinedAt),
})
const isActiveSuperAdministrator = (member: OrganizationApi.Member) =>
	member.status === "active" && member.roles.includes("super_administrator")
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1)

export const make = (
	options: Options = {},
): Effect.Effect<
	typeof Organization.Service,
	never,
	PgClient.PgClient | AuditLog
> =>
	Effect.gen(function* () {
		const db = yield* makeWithDefaults()
		const audit = yield* AuditLog
		const ownerEmails = (options.ownerEmails ?? []).map((email) =>
			email.trim().toLowerCase(),
		)
		const unavailable = () => OrganizationUnavailable.make({})

		/** Run one change to members at a time, so the Super Administrator check stays true. */
		const lockMembers = (
			tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
		) =>
			tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended('openbot-members', 0))`,
			)
		const findMember = (userId: string) =>
			db
				.select()
				.from(members)
				.where(eq(members.userId, userId))
				.limit(1)
				.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))

		const admit: (typeof Organization.Service)["admit"] = (account) =>
			Effect.gen(function* () {
				const existing = yield* findMember(account.id)
				if (Option.isSome(existing)) {
					const row = existing.value
					if (row.status !== "active") return yield* MembershipRejected.make({})
					if (
						(account.email ?? null) !== row.email ||
						(account.name ?? null) !== row.name
					)
						yield* db
							.update(members)
							.set({ email: account.email ?? null, name: account.name ?? null })
							.where(
								and(
									eq(members.organizationId, row.organizationId),
									eq(members.userId, row.userId),
								),
							)
					return { organizationId: row.organizationId, joined: false }
				}
				const joined = yield* db.transaction((tx) =>
					Effect.gen(function* () {
						yield* lockMembers(tx)
						const now = yield* Clock.currentTimeMillis
						const [current] = yield* tx.select().from(organizations).limit(1)
						const organization = current ?? {
							id: "org_" + randomUUID().replaceAll("-", ""),
							name: "OpenBot",
							allowedEmailDomains: JSON.stringify(
								(options.allowedEmailDomains ?? []).map((domain) =>
									domain.trim().toLowerCase(),
								),
							),
							defaultRoles: JSON.stringify(["member"]),
							createdAt: now,
						}
						if (current === undefined)
							yield* tx.insert(organizations).values(organization)
						const [again] = yield* tx
							.select()
							.from(members)
							.where(eq(members.userId, account.id))
						if (again !== undefined)
							return again.status === "active"
								? { organizationId: again.organizationId, joined: false }
								: yield* MembershipRejected.make({})
						const [count] = yield* tx
							.select({ total: sql<number>`count(*)::int` })
							.from(members)
							.where(eq(members.organizationId, organization.id))
						const email = account.email?.trim().toLowerCase()
						const verified = account.emailVerified === true
						const roles =
							email !== undefined && verified && ownerEmails.includes(email)
								? ["super_administrator"]
								: (count?.total ?? 0) === 0 && ownerEmails.length === 0
									? ["super_administrator"]
									: email !== undefined &&
										  verified &&
										  decodeDomains(organization.allowedEmailDomains).includes(
												domainOf(email),
										  )
										? decodeRoles(organization.defaultRoles)
										: undefined
						if (roles === undefined) return yield* MembershipRejected.make({})
						yield* tx.insert(members).values({
							organizationId: organization.id,
							userId: account.id,
							email: account.email ?? null,
							name: account.name ?? null,
							status: "active",
							roles: JSON.stringify(roles),
							policies: JSON.stringify([]),
							joinedAt: now,
						})
						return { organizationId: organization.id, joined: true, roles }
					}),
				)
				if (joined.joined)
					yield* audit.record({
						organizationId: joined.organizationId,
						action: "member.joined",
						actor: {
							kind: "member",
							userId: account.id,
							organizationId: joined.organizationId,
						},
						resource: userKey({
							organizationId: joined.organizationId,
							userId: account.id,
						}),
						details: { roles: "roles" in joined ? [...joined.roles] : [] },
					})
				return { organizationId: joined.organizationId, joined: joined.joined }
			}).pipe(
				Effect.mapError((error) =>
					error._tag === "MembershipRejected" ? error : unavailable(),
				),
			)

		const updateMembers = <A, E>(
			organizationId: string,
			userId: string,
			change: (
				member: OrganizationApi.Member,
				tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
			) => Effect.Effect<A, E>,
			after: (member: OrganizationApi.Member) => OrganizationApi.Member | null,
		) =>
			db.transaction((tx) =>
				Effect.gen(function* () {
					yield* lockMembers(tx)
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
			member: (organizationId, userId) =>
				db
					.select()
					.from(members)
					.where(
						and(
							eq(members.organizationId, organizationId),
							eq(members.userId, userId),
						),
					)
					.pipe(
						Effect.map((rows) =>
							Option.map(Option.fromNullishOr(rows[0]), memberView),
						),
						Effect.mapError(unavailable),
					),
			get: (organizationId) =>
				db
					.select()
					.from(organizations)
					.where(eq(organizations.id, organizationId))
					.pipe(
						Effect.flatMap(([row]) =>
							row === undefined
								? Effect.fail(unavailable())
								: Effect.succeed(organizationView(row)),
						),
						Effect.mapError(unavailable),
					),
			update: (organizationId, patch) =>
				db
					.update(organizations)
					.set({
						...(patch.name === undefined ? {} : { name: patch.name.trim() }),
						...(patch.allowedEmailDomains === undefined
							? {}
							: {
									allowedEmailDomains: JSON.stringify(
										patch.allowedEmailDomains,
									),
								}),
						...(patch.defaultRoles === undefined
							? {}
							: { defaultRoles: JSON.stringify(patch.defaultRoles) }),
					})
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
							.where(
								and(
									eq(members.organizationId, organizationId),
									eq(members.userId, userId),
								),
							)
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
							yield* tx
								.delete(members)
								.where(
									and(
										eq(members.organizationId, organizationId),
										eq(members.userId, userId),
									),
								)
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
		})
	})
export const layer = (options?: Options) =>
	Layer.effect(Organization, make(options))
