import {
	type BotsApi,
	type AuthApi,
	OrganizationApi,
	Permissions,
	PlatformApi,
} from "@openbot-build/api"
import type { PgClient } from "@effect/sql-pg"
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect"
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gt,
	isNotNull,
	like,
	sql,
	type SQL,
} from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { openbot_auth_user } from "../database/AuthSchema.ts"
import {
	invitations,
	members,
	organizationDomains,
	organizations,
	tokens,
} from "../database/Schema.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey, userKey } from "../authorization/Policy.ts"
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
const decodeInvitationStatus = Schema.decodeUnknownSync(
	OrganizationApi.InvitationStatus,
)
/** An email invitation lasts 7 days. */
const invitationLifetime = 7 * 24 * 60 * 60 * 1000
type InvitationRow = typeof invitations.$inferSelect
/** A pending invitation past its end counts as expired. A link without an end never expires. */
const statusOf = (row: InvitationRow, now: number) =>
	row.status === "pending" && row.expiresAt !== null && row.expiresAt <= now
		? "expired"
		: decodeInvitationStatus(row.status)
const invitationView = (
	row: InvitationRow & { readonly organizationName: string },
	now: number,
): OrganizationApi.Invitation => ({
	id: row.id,
	organizationId: row.organizationId,
	organizationName: row.organizationName,
	// Only Bot links have no email, and this view never shows them.
	email: row.email ?? "",
	// An invitation to a Bot gives no roles in the organization.
	roles: row.target === "bot" ? [] : decodeRoles(row.roles),
	status: statusOf(row, now),
	invitedBy: row.invitedBy,
	createdAt: iso(row.createdAt),
	expiresAt: iso(row.expiresAt ?? row.createdAt),
	...(row.target === "bot" && row.botId !== null
		? { bot: { id: row.botId, name: row.botName ?? "" } }
		: {}),
})
const botInvitationView = (
	row: InvitationRow,
	now: number,
): BotsApi.BotInvitation => ({
	id: row.id,
	bot: (row.botId ?? "") as BotsApi.BotId,
	email: row.email,
	prefix: row.prefix,
	path: row.path,
	status: statusOf(row, now),
	invitedBy: row.invitedBy,
	createdAt: iso(row.createdAt),
	expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
})
const isActiveSuperAdministrator = (member: OrganizationApi.Member) =>
	member.status === "active" && member.roles.includes("super_administrator")
const newId = () => "org_" + randomUUID().replaceAll("-", "")
const newInvitationId = () => "inv_" + randomUUID().replaceAll("-", "")

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

	/** Creates an organization and makes its owner the Super Administrator. */
	const create = (input: { readonly name: string; readonly owner: Account }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const row = {
				id: newId(),
				name: input.name.trim(),
				status: "active",
				createdAt: now,
			}
			yield* db.transaction((tx) =>
				Effect.gen(function* () {
					yield* tx.insert(organizations).values(row)
					yield* join(tx, row.id, input.owner, ["super_administrator"], now)
				}),
			)
			yield* audit
				.record({
					organizationId: row.id,
					action: "organization.created",
					actor: {
						kind: "member",
						userId: input.owner.id,
						organizationId: row.id,
					},
					resource: organizationKey(row.id),
					details: { name: row.name },
				})
				.pipe(Effect.mapError(unavailable))
			yield* recordJoin(row.id, input.owner, ["super_administrator"])
			return organizationView(row)
		}).pipe(Effect.mapError(unavailable))

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
			}
			return before
		}).pipe(
			Effect.mapError((error) =>
				error._tag === "OrganizationUnavailable" ? error : unavailable(),
			),
		)

	/** The invitations with the name of their organization, newest first. */
	const invitationRows = (where: SQL | undefined) =>
		db
			.select({
				...getTableColumns(invitations),
				organizationName: organizations.name,
			})
			.from(invitations)
			.innerJoin(
				organizations,
				eq(organizations.id, invitations.organizationId),
			)
			.where(where)
			.orderBy(desc(invitations.createdAt), desc(invitations.id))
			.pipe(Effect.mapError(unavailable))
	/** The invitations to use one Bot, newest first. */
	const botInvitationRows = (organizationId: string, bot: string) =>
		db
			.select()
			.from(invitations)
			.where(
				and(
					eq(invitations.organizationId, organizationId),
					eq(invitations.target, "bot"),
					eq(invitations.botId, bot),
				),
			)
			.orderBy(desc(invitations.createdAt), desc(invitations.id))
			.pipe(Effect.mapError(unavailable))
	/** The account of a user, with its email in lower case. */
	const accountOf = (userId: string) =>
		db
			.select({
				id: openbot_auth_user.id,
				name: openbot_auth_user.name,
				email: openbot_auth_user.email,
				emailVerified: openbot_auth_user.emailVerified,
			})
			.from(openbot_auth_user)
			.where(eq(openbot_auth_user.id, userId))
			.pipe(
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), (row) => ({
						...row,
						email: row.email.toLowerCase(),
					})),
				),
				Effect.mapError(unavailable),
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
		listInvitations: (organizationId, status) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* invitationRows(
					and(
						eq(invitations.organizationId, organizationId),
						eq(invitations.target, "organization"),
					),
				)
				return rows
					.map((row) => invitationView(row, now))
					.filter(
						(invitation) =>
							status === undefined || invitation.status === status,
					)
			}),
		createInvitation: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const email = input.email.trim().toLowerCase()
				const row = {
					id: newInvitationId(),
					organizationId: input.organizationId,
					email,
					roles: JSON.stringify(input.roles),
					status: "pending",
					invitedBy: input.invitedBy,
					createdAt: now,
					expiresAt: now + invitationLifetime,
				}
				yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* lockMembers(tx, input.organizationId)
							const member = yield* tx
								.select({ userId: members.userId })
								.from(members)
								.where(
									and(
										eq(members.organizationId, input.organizationId),
										sql`lower(${members.email}) = ${email}`,
									),
								)
								.limit(1)
							if (member.length > 0)
								return yield* OrganizationApi.InvitationInvalid.make({
									message: "A member already has this email.",
								})
							const pending = yield* tx
								.select({ id: invitations.id })
								.from(invitations)
								.where(
									and(
										eq(invitations.organizationId, input.organizationId),
										eq(invitations.target, "organization"),
										eq(invitations.email, email),
										eq(invitations.status, "pending"),
										gt(invitations.expiresAt, now),
									),
								)
								.limit(1)
							if (pending.length > 0)
								return yield* OrganizationApi.InvitationInvalid.make({
									message: "This email already has a pending invitation.",
								})
							yield* tx.insert(invitations).values(row)
						}),
					)
					.pipe(
						Effect.mapError((error) =>
							error._tag === "InvitationInvalid" ? error : unavailable(),
						),
					)
				const [created] = yield* invitationRows(eq(invitations.id, row.id))
				if (created === undefined) return yield* unavailable()
				return invitationView(created, now)
			}),
		revokeInvitation: (organizationId, invitationId) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const [row] = yield* invitationRows(
					and(
						eq(invitations.organizationId, organizationId),
						eq(invitations.target, "organization"),
						eq(invitations.id, invitationId),
					),
				)
				if (row === undefined)
					return yield* OrganizationApi.InvitationNotFound.make({
						invitationId,
					})
				const current = invitationView(row, now)
				if (current.status !== "pending")
					return yield* OrganizationApi.InvitationInvalid.make({
						message: `The invitation is ${current.status}.`,
					})
				yield* db
					.update(invitations)
					.set({ status: "revoked" })
					.where(
						and(
							eq(invitations.id, invitationId),
							eq(invitations.status, "pending"),
						),
					)
					.pipe(Effect.mapError(unavailable))
				return { ...current, status: "revoked" as const }
			}),
		invitationsFor: (userId) =>
			Effect.gen(function* () {
				const account = yield* accountOf(userId)
				if (Option.isNone(account) || !account.value.emailVerified) return []
				const now = yield* Clock.currentTimeMillis
				const rows = yield* invitationRows(
					and(
						eq(invitations.email, account.value.email),
						eq(invitations.status, "pending"),
						gt(invitations.expiresAt, now),
					),
				)
				return rows.map((row) => invitationView(row, now))
			}),
		answerInvitation: (userId, invitationId, answer) =>
			Effect.gen(function* () {
				const notFound = OrganizationApi.InvitationNotFound.make({
					invitationId,
				})
				const account = yield* accountOf(userId)
				const [row] = yield* invitationRows(eq(invitations.id, invitationId))
				// An invitation for another email stays hidden.
				if (
					row === undefined ||
					Option.isNone(account) ||
					account.value.email !== row.email
				)
					return yield* notFound
				if (!account.value.emailVerified)
					return yield* OrganizationApi.InvitationInvalid.make({
						message: "Verify your email address first.",
					})
				if (row.target === "bot" && answer === "accepted")
					return yield* OrganizationApi.InvitationInvalid.make({
						message:
							"This invitation is for a Bot. Accept it with POST /v1/bot-invitations/accept.",
					})
				const now = yield* Clock.currentTimeMillis
				const roles = decodeRoles(row.roles)
				const joined = yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* lockMembers(tx, row.organizationId)
							const [locked] = yield* tx
								.select()
								.from(invitations)
								.where(eq(invitations.id, invitationId))
							const status =
								locked === undefined
									? "revoked"
									: invitationView(
											{ ...locked, organizationName: row.organizationName },
											now,
										).status
							if (status !== "pending")
								return yield* OrganizationApi.InvitationInvalid.make({
									message: `The invitation is ${status}.`,
								})
							yield* tx
								.update(invitations)
								.set({ status: answer })
								.where(eq(invitations.id, invitationId))
							return answer === "accepted"
								? yield* join(
										tx,
										row.organizationId,
										{
											id: account.value.id,
											email: account.value.email,
											name: account.value.name,
										},
										roles,
										now,
									)
								: false
						}),
					)
					.pipe(
						Effect.mapError((error) =>
							error._tag === "InvitationInvalid" ? error : unavailable(),
						),
					)
				if (joined)
					yield* recordJoin(row.organizationId, { id: account.value.id }, roles)
				return { ...invitationView(row, now), status: answer }
			}),
		listBotInvitations: (organizationId, bot, status) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* botInvitationRows(organizationId, bot)
				return rows
					.map((row) => botInvitationView(row, now))
					.filter(
						(invitation) =>
							status === undefined || invitation.status === status,
					)
			}),
		createBotInvitation: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const email = input.email?.trim().toLowerCase() ?? null
				const row: InvitationRow = {
					id: newInvitationId(),
					organizationId: input.organizationId,
					target: "bot",
					botId: input.bot.id,
					botName: input.bot.name,
					email,
					roles: "[]",
					status: "pending",
					invitedBy: input.invitedBy,
					prefix: input.link?.prefix ?? null,
					secretHash: input.link?.hash ?? null,
					secret: input.link?.sealed ?? null,
					path: input.path ?? null,
					createdAt: now,
					// An email invitation lasts 7 days, like an invitation to the organization.
					expiresAt:
						email === null
							? (input.expiresAt ?? null)
							: now + invitationLifetime,
				}
				yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* lockMembers(tx, input.organizationId)
							// One email has at most one pending invitation to a Bot.
							if (email !== null) {
								const pending = yield* tx
									.select({ id: invitations.id })
									.from(invitations)
									.where(
										and(
											eq(invitations.organizationId, input.organizationId),
											eq(invitations.target, "bot"),
											eq(invitations.botId, input.bot.id),
											eq(invitations.email, email),
											eq(invitations.status, "pending"),
											gt(invitations.expiresAt, now),
										),
									)
									.limit(1)
								if (pending.length > 0)
									return yield* OrganizationApi.InvitationInvalid.make({
										message: "This email already has a pending invitation.",
									})
							}
							yield* tx.insert(invitations).values(row)
						}),
					)
					.pipe(
						Effect.mapError((error) =>
							error._tag === "InvitationInvalid" ? error : unavailable(),
						),
					)
				return botInvitationView(row, now)
			}),
		botInvitation: (organizationId, bot, invitationId) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const row = (yield* botInvitationRows(organizationId, bot)).find(
					(row) => row.id === invitationId,
				)
				if (row === undefined)
					return yield* OrganizationApi.InvitationNotFound.make({
						invitationId,
					})
				return {
					invitation: botInvitationView(row, now),
					link:
						row.secretHash === null ||
						row.secret === null ||
						row.prefix === null
							? null
							: {
									hash: row.secretHash,
									sealed: row.secret,
									prefix: row.prefix,
								},
				}
			}),
		revokeBotInvitation: (organizationId, bot, invitationId) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const row = (yield* botInvitationRows(organizationId, bot)).find(
					(row) => row.id === invitationId,
				)
				if (row === undefined)
					return yield* OrganizationApi.InvitationNotFound.make({
						invitationId,
					})
				const current = botInvitationView(row, now)
				if (current.status !== "pending")
					return yield* OrganizationApi.InvitationInvalid.make({
						message: `The invitation is ${current.status}.`,
					})
				yield* db
					.update(invitations)
					.set({ status: "revoked" })
					.where(
						and(
							eq(invitations.id, invitationId),
							eq(invitations.status, "pending"),
						),
					)
					.pipe(Effect.mapError(unavailable))
				return { ...current, status: "revoked" as const }
			}),
		takeBotInvitation: (userId, by) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const id = by._tag === "Email" ? by.invitationId : ""
				const notFound = OrganizationApi.InvitationNotFound.make({
					invitationId: id,
				})
				const [row] = yield* db
					.select()
					.from(invitations)
					.where(
						and(
							eq(invitations.target, "bot"),
							by._tag === "Email"
								? eq(invitations.id, by.invitationId)
								: eq(invitations.secretHash, by.secretHash),
						),
					)
					.pipe(Effect.mapError(unavailable))
				if (row === undefined || row.botId === null) return yield* notFound
				const taken = {
					invitationId: row.id,
					organizationId: row.organizationId,
					bot: row.botId,
				}
				if (by._tag === "Link") {
					// A link stays open, so many people can use it.
					if (row.email !== null) return yield* notFound
					const status = statusOf(row, now)
					if (status !== "pending")
						return yield* OrganizationApi.InvitationInvalid.make({
							message: `The invitation is ${status}.`,
						})
					return taken
				}
				// An invitation for another email stays hidden.
				const account = yield* accountOf(userId)
				if (Option.isNone(account) || account.value.email !== row.email)
					return yield* notFound
				if (!account.value.emailVerified)
					return yield* OrganizationApi.InvitationInvalid.make({
						message: "Verify your email address first.",
					})
				yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* lockMembers(tx, row.organizationId)
							const [locked] = yield* tx
								.select()
								.from(invitations)
								.where(eq(invitations.id, row.id))
							const status =
								locked === undefined ? "revoked" : statusOf(locked, now)
							if (status !== "pending")
								return yield* OrganizationApi.InvitationInvalid.make({
									message: `The invitation is ${status}.`,
								})
							yield* tx
								.update(invitations)
								.set({ status: "accepted" })
								.where(
									and(
										eq(invitations.id, row.id),
										eq(invitations.status, "pending"),
									),
								)
						}),
					)
					.pipe(
						Effect.mapError((error) =>
							error._tag === "InvitationInvalid" ? error : unavailable(),
						),
					)
				return taken
			}),
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
