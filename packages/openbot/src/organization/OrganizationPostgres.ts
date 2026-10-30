import { RoleId } from "@openbot-build/domain/Roles"
import {
	BotId,
	BotSharing as BotSharingModel,
	type Accounts as AccountsModel,
	Organizations as OrganizationsModel,
	Platform as PlatformModel,
} from "@openbot-build/domain"

import { Authorization } from "@openbot-build/domain"
import type { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Cause,
	Clock,
	Crypto,
	DateTime,
	Effect,
	Layer,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
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
import { openbot_auth_user } from "../database/AuthSchema.ts"
import {
	invitations,
	mappedRoles,
	accountStates,
	members,
	organizationDomains,
	organizations,
	tokens,
} from "../database/Schema.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey, userKey } from "../audit/Resources.ts"
import { Settings } from "../settings/Settings.ts"
import {
	type Account,
	domainOf,
	Organization,
	OrganizationUnavailable,
} from "./Organization.ts"
import * as Db from "../database/Database.ts"

const Roles = Schema.fromJsonString(Schema.Array(RoleId))
const PolicyJson = Authorization.PolicySchema
const unavailable = (cause: unknown) => OrganizationUnavailable.make({ cause })
/** A row that must be in the database is not there. */
const missing = (what: string) =>
	unavailable(new Cause.NoSuchElementError(what))

// The rows come from the database, so a bad value is a typed failure.
const decodeRoles = (text: string) =>
	Schema.decodeEffect(Roles)(text).pipe(Effect.mapError(unavailable))
const decodePolicy = (text: string) =>
	Schema.decodeEffect(PolicyJson)(text).pipe(Effect.mapError(unavailable))
const decodeStatus = (status: string) =>
	Schema.decodeUnknownEffect(OrganizationsModel.MemberStatus)(status).pipe(
		Effect.mapError(unavailable),
	)
const decodeOrganizationStatus = (status: string) =>
	Schema.decodeUnknownEffect(OrganizationsModel.OrganizationStatus)(
		status,
	).pipe(Effect.mapError(unavailable))
const decodeInvitationStatus = (status: string) =>
	Schema.decodeUnknownEffect(OrganizationsModel.InvitationStatus)(status).pipe(
		Effect.mapError(unavailable),
	)
const decodeBotId = (id: string | null) =>
	Schema.decodeUnknownEffect(BotId)(id).pipe(Effect.mapError(unavailable))
// Only this file writes these columns, from checked values, so a failed encode is a defect.
const encodeRoles = (roles: typeof Roles.Type) =>
	Schema.encodeEffect(Roles)(roles).pipe(Effect.orDie)
const encodePolicy = (policy: typeof PolicyJson.Type) =>
	Schema.encodeEffect(PolicyJson)(policy).pipe(Effect.orDie)

const organizationView = (
	row: typeof organizations.$inferSelect,
): Effect.Effect<OrganizationsModel.Organization, OrganizationUnavailable> =>
	Effect.map(decodeOrganizationStatus(row.status), (status) => ({
		id: row.id,
		kind: row.personalOwnerUserId === null ? "organization" : "personal",
		ownerUserId: row.personalOwnerUserId,
		name: row.name,
		status,
		createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
	}))
const memberViewBase = (
	row: typeof members.$inferSelect,
): Effect.Effect<OrganizationsModel.Member, OrganizationUnavailable> =>
	Effect.gen(function* () {
		return {
			userId: row.userId,
			email: row.email,
			name: row.name,
			status: yield* decodeStatus(row.status),
			roles: yield* decodeRoles(row.roles),
			policy: yield* decodePolicy(row.policy),
			joinedAt: DateTime.formatIso(DateTime.makeUnsafe(row.joinedAt)),
		}
	})
/** An email invitation lasts 7 days. */
const invitationLifetime = 7 * 24 * 60 * 60 * 1000
type InvitationRow = typeof invitations.$inferSelect
/** A pending invitation past its end counts as expired. A link without an end never expires. */
const statusOf = (
	row: InvitationRow,
	now: number,
): Effect.Effect<
	OrganizationsModel.InvitationStatus,
	OrganizationUnavailable
> =>
	row.status === "pending" && row.expiresAt !== null && row.expiresAt <= now
		? Effect.succeed("expired")
		: decodeInvitationStatus(row.status)
const invitationView = (
	row: InvitationRow & { readonly organizationName: string },
	now: number,
): Effect.Effect<OrganizationsModel.Invitation, OrganizationUnavailable> =>
	Effect.gen(function* () {
		return {
			id: OrganizationsModel.InvitationId.make(row.id),
			organizationId: row.organizationId,
			organizationName: row.organizationName,
			// Only Bot links have no email, and this view never shows them.
			email: row.email ?? "",
			// An invitation to a Bot gives no roles in the organization.
			roles: row.target === "bot" ? [] : yield* decodeRoles(row.roles),
			status: yield* statusOf(row, now),
			invitedBy: row.invitedBy,
			createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
			expiresAt: DateTime.formatIso(
				DateTime.makeUnsafe(row.expiresAt ?? row.createdAt),
			),
			...(row.target === "bot" && row.botId !== null
				? { bot: { id: row.botId, name: row.botName ?? "" } }
				: {}),
		}
	})
const botInvitationView = (
	row: InvitationRow,
	now: number,
): Effect.Effect<BotSharingModel.BotInvitation, OrganizationUnavailable> =>
	Effect.gen(function* () {
		return {
			id: OrganizationsModel.InvitationId.make(row.id),
			bot: yield* decodeBotId(row.botId),
			email: row.email,
			prefix: row.prefix,
			path: row.path,
			status: yield* statusOf(row, now),
			invitedBy: row.invitedBy,
			createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
			expiresAt:
				row.expiresAt === null
					? null
					: DateTime.formatIso(DateTime.makeUnsafe(row.expiresAt)),
		}
	})

export const make: Effect.Effect<
	typeof Organization.Service,
	never,
	PgClient.PgClient | AuditLog | Settings | Crypto.Crypto
> = Effect.gen(function* () {
	const db = yield* Db.make
	const effectiveRoles = (
		organizationId: string,
		userId: string,
		manual: string,
	) =>
		Effect.gen(function* () {
			const roles = yield* decodeRoles(manual)
			const mapped = yield* db
				.select()
				.from(mappedRoles)
				.where(
					and(
						eq(mappedRoles.organizationId, organizationId),
						eq(mappedRoles.userId, userId),
					),
				)
				.pipe(Effect.mapError(unavailable))
			const all = yield* Schema.decodeEffect(Schema.Array(RoleId))(
				Arr.dedupe([...roles, ...Arr.map(mapped, (r) => r.role)]),
			).pipe(Effect.mapError(unavailable))
			return {
				roles: all,
				manualRoles: roles,
				roleSources: Arr.map(mapped, (r) => ({
					providerId: r.providerId,
					role: r.role,
				})),
			}
		})
	const accountActive = (userId: string) =>
		db
			.select()
			.from(accountStates)
			.where(eq(accountStates.userId, userId))
			.pipe(
				Effect.map((rows) => rows[0]?.status !== "suspended"),
				Effect.mapError(unavailable),
			)
	const memberView = (row: typeof members.$inferSelect) =>
		Effect.gen(function* () {
			const base = yield* memberViewBase(row)
			const source = yield* effectiveRoles(
				row.organizationId,
				row.userId,
				row.roles,
			)
			return {
				...base,
				...source,
			}
		})

	type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
	const audit = yield* AuditLog
	const settings = yield* Settings
	const crypto = yield* Crypto.Crypto
	const newId = crypto
		.randomUUIDv7()
		.pipe(Effect.orDie, Effect.map(Str.replaceAll("-", "")))

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
				personalOwnerUserId: organizations.personalOwnerUserId,
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
				Effect.mapError(unavailable),
				Effect.flatMap((rows) =>
					Effect.forEach(
						rows,
						(
							row,
						): Effect.Effect<
							AccountsModel.Membership,
							OrganizationUnavailable
						> =>
							Effect.gen(function* () {
								return {
									organizationId: row.organizationId,
									kind:
										row.personalOwnerUserId === null
											? "organization"
											: "personal",
									ownerUserId: row.personalOwnerUserId,
									name: row.name,
									// A suspended organization suspends every membership in it.
									status:
										row.organizationStatus === "active" &&
										(yield* accountActive(userId)) &&
										(yield* effectiveRoles(
											row.organizationId,
											userId,
											row.roles,
										)).roles.length > 0
											? yield* decodeStatus(row.status)
											: "suspended",
									roles: (yield* effectiveRoles(
										row.organizationId,
										userId,
										row.roles,
									)).roles,
								}
							}),
					),
				),
			)

	const recordJoin = (
		organizationId: string,
		account: Account,
		roles: typeof Roles.Type,
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
		roles: typeof Roles.Type,
		now: number,
	) =>
		Effect.gen(function* () {
			const rows = yield* tx
				.insert(members)
				.values({
					organizationId,
					userId: account.id,
					email: account.email ?? null,
					name: account.name ?? null,
					status: "active",
					roles: yield* encodeRoles(roles),
					policy: yield* encodePolicy(Authorization.emptyPolicy),
					joinedAt: now,
				})
				.onConflictDoNothing()
				.returning({ userId: members.userId })
			return rows.length > 0
		})

	/** Creates an organization and makes its owner the Super Administrator. */
	const create = (input: { readonly name: string; readonly owner: Account }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const row = {
				id: "org_" + (yield* newId),
				personalOwnerUserId: null,
				name: Str.trim(input.name),
				status: "active",
				createdAt: now,
			}
			yield* db
				.transaction((tx) =>
					Effect.gen(function* () {
						yield* tx.insert(organizations).values(row)
						yield* join(tx, row.id, input.owner, ["super_administrator"], now)
					}),
				)
				.pipe(Effect.mapError(unavailable))
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
			return yield* organizationView(row)
		})

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

	const admit: (typeof Organization.Service)["admit"] = (account, only) =>
		Effect.gen(function* () {
			const before = yield* memberships(account.id)
			const target = Option.filter(
				Option.isSome(only) ? only : yield* domainOrganization(account),
				(id) => !Arr.some(before, (member) => member.organizationId === id),
			)
			if (Option.isSome(target)) {
				const organizationId = target.value
				const current = yield* settings.organization(organizationId)
				if (Option.isSome(only) || current.document.joinByDomain) {
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
			Effect.catchTag("SettingsUnavailable", (error) =>
				Effect.fail(unavailable(error)),
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
	/** One invitation to use a Bot. */
	const botInvitationRow = (
		organizationId: string,
		bot: string,
		invitationId: string,
	) =>
		db
			.select()
			.from(invitations)
			.where(
				and(
					eq(invitations.organizationId, organizationId),
					eq(invitations.target, "bot"),
					eq(invitations.botId, bot),
					eq(invitations.id, invitationId),
				),
			)
			.pipe(Effect.mapError(unavailable), Effect.map(Arr.head))
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
					Option.map(Arr.head(rows), (row) => ({
						...row,
						email: Str.toLowerCase(row.email),
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
				Effect.mapError(unavailable),
				Effect.flatMap((rows) =>
					Effect.transposeOption(Option.map(Arr.head(rows), memberView)),
				),
			)
	const findOrganization = (organizationId: string) =>
		db
			.select()
			.from(organizations)
			.where(eq(organizations.id, organizationId))
			.pipe(
				Effect.mapError(unavailable),
				Effect.flatMap((rows) =>
					Effect.transposeOption(Option.map(Arr.head(rows), organizationView)),
				),
			)

	const updateMembers = <A, E>(
		organizationId: string,
		userId: string,
		change: (
			member: OrganizationsModel.Member,
			tx: Transaction,
		) => Effect.Effect<A, E>,
		after: (
			member: OrganizationsModel.Member,
		) => OrganizationsModel.Member | null,
	) =>
		db.transaction((tx) =>
			Effect.gen(function* () {
				yield* lockMembers(tx, organizationId)
				const rows = yield* tx
					.select()
					.from(members)
					.where(eq(members.organizationId, organizationId))
				const all = yield* Effect.forEach(rows, memberView)
				const target = Arr.findFirst(all, (member) => member.userId === userId)
				if (Option.isNone(target))
					return yield* OrganizationsModel.MemberNotFound.make({ userId })
				const remaining = Arr.flatMap(all, (member) => {
					if (member.userId !== userId) return [member]
					const next = after(member)
					return next === null ? [] : [next]
				})
				if (
					!Arr.some(
						remaining,
						(member) =>
							member.status === "active" &&
							member.roles.includes("super_administrator"),
					)
				)
					return yield* OrganizationsModel.LastSuperAdministrator.make({})
				return yield* change(target.value, tx)
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
				if (!(yield* accountActive(userId))) return Option.none()
				return Option.filter(
					yield* findMember(organizationId, userId),
					(member) => member.status === "active" && member.roles.length > 0,
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
					Effect.mapError(unavailable),
					Effect.flatMap((rows) =>
						Effect.map(
							Effect.forEach(Arr.take(rows, limit), organizationView),
							(page) => ({
								items: page,
								next:
									rows.length > limit
										? (page[page.length - 1]?.id ?? null)
										: null,
							}),
						),
					),
				),

		ensurePersonal: (account) =>
			Effect.gen(function* () {
				if (!(yield* accountActive(account.id)))
					return yield* missing("The account is not active.")
				const now = yield* Clock.currentTimeMillis
				return yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.execute(
								sql`select pg_advisory_xact_lock(hashtextextended(${"personal:" + account.id}, 0))`,
							)
							const [existing] = yield* tx
								.select()
								.from(organizations)
								.where(eq(organizations.personalOwnerUserId, account.id))
							if (existing !== undefined) return existing.id
							const id = "org_" + (yield* newId)
							yield* tx.insert(organizations).values({
								id,
								name: "Personal",
								status: "active",
								personalOwnerUserId: account.id,
								createdAt: now,
							})
							yield* join(tx, id, account, ["super_administrator"], now)
							return id
						}),
					)
					.pipe(Effect.mapError(unavailable))
			}),
		create,
		update: (organizationId, patch) =>
			patch.name === undefined
				? findOrganization(organizationId).pipe(
						Effect.flatMap(
							Effect.fromOption(() =>
								missing("The organization does not exist."),
							),
						),
					)
				: db
						.update(organizations)
						.set({ name: Str.trim(patch.name) })
						.where(eq(organizations.id, organizationId))
						.returning()
						.pipe(
							Effect.mapError(unavailable),
							Effect.flatMap(([row]) =>
								row === undefined
									? Effect.fail(missing("The organization does not exist."))
									: organizationView(row),
							),
						),
		setStatus: (organizationId, status) =>
			Effect.gen(function* () {
				const [row] = yield* db
					.update(organizations)
					.set({ status })
					.where(eq(organizations.id, organizationId))
					.returning()
					.pipe(Effect.mapError(unavailable))
				if (row === undefined)
					return yield* PlatformModel.OrganizationNotFound.make({
						organizationId,
					})
				return yield* organizationView(row)
			}),
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
					Effect.mapError(unavailable),
					Effect.flatMap((rows) =>
						Effect.map(
							Effect.forEach(Arr.take(rows, limit), memberView),
							(page) => ({
								items: page,
								next:
									rows.length > limit
										? (page[page.length - 1]?.userId ?? null)
										: null,
							}),
						),
					),
				),
		updateMember: (organizationId, userId, patch) => {
			const apply = (member: OrganizationsModel.Member) => ({
				...member,
				...(patch.status === undefined ? {} : { status: patch.status }),
				...(patch.roles === undefined
					? {}
					: {
							manualRoles: patch.roles,
							roles: Arr.dedupe([
								...patch.roles,
								...Arr.map(member.roleSources ?? [], (s) => s.role as RoleId),
							]),
						}),
				...(patch.policy === undefined ? {} : { policy: patch.policy }),
			})
			return updateMembers(
				organizationId,
				userId,
				(member, tx) =>
					Effect.gen(function* () {
						const next = apply(member)
						yield* tx
							.update(members)
							.set({
								status: next.status,
								...(patch.roles === undefined
									? {}
									: { roles: yield* encodeRoles(patch.roles) }),
								policy: yield* encodePolicy(next.policy),
							})
							.where(memberWhere(organizationId, userId))
						return next
					}),
				apply,
			).pipe(
				Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
					Effect.fail(unavailable(error)),
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
							.delete(mappedRoles)
							.where(
								and(
									eq(mappedRoles.organizationId, organizationId),
									eq(mappedRoles.userId, userId),
								),
							)
						yield* tx.delete(members).where(memberWhere(organizationId, userId))
					}),
				() => null,
			).pipe(
				Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
					Effect.fail(unavailable(error)),
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
				const views = yield* Effect.forEach(rows, (row) =>
					invitationView(row, now),
				)
				return Arr.filter(
					views,
					(invitation) => status === undefined || invitation.status === status,
				)
			}),
		createInvitation: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const email = pipe(input.email, Str.trim, Str.toLowerCase)
				const row = {
					id: "inv_" + (yield* newId),
					organizationId: input.organizationId,
					email,
					roles: yield* encodeRoles(input.roles),
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
								return yield* OrganizationsModel.InvitationInvalid.make({
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
								return yield* OrganizationsModel.InvitationInvalid.make({
									message: "This email already has a pending invitation.",
								})
							yield* tx.insert(invitations).values(row)
						}),
					)
					.pipe(
						Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
							Effect.fail(unavailable(error)),
						),
					)
				const [created] = yield* invitationRows(eq(invitations.id, row.id))
				if (created === undefined)
					return yield* missing("The new invitation is not in the database.")
				return yield* invitationView(created, now)
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
					return yield* OrganizationsModel.InvitationNotFound.make({
						invitationId: OrganizationsModel.InvitationId.make(invitationId),
					})
				const current = yield* invitationView(row, now)
				if (current.status !== "pending")
					return yield* OrganizationsModel.InvitationInvalid.make({
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
				return yield* Effect.forEach(rows, (row) => invitationView(row, now))
			}),
		answerInvitation: (userId, invitationId, answer) =>
			Effect.gen(function* () {
				const notFound = OrganizationsModel.InvitationNotFound.make({
					invitationId: OrganizationsModel.InvitationId.make(invitationId),
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
					return yield* OrganizationsModel.InvitationInvalid.make({
						message: "Verify your email address first.",
					})
				if (row.target === "bot" && answer === "accepted")
					return yield* OrganizationsModel.InvitationInvalid.make({
						message:
							"This invitation is for a Bot. Accept it with POST /v1/bot-invitations/accept.",
					})
				const now = yield* Clock.currentTimeMillis
				const roles = yield* decodeRoles(row.roles)
				const joined = yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* lockMembers(tx, row.organizationId)
							const [locked] = yield* tx
								.select()
								.from(invitations)
								.where(eq(invitations.id, invitationId))
							const status =
								locked === undefined ? "revoked" : yield* statusOf(locked, now)
							if (status !== "pending")
								return yield* OrganizationsModel.InvitationInvalid.make({
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
						Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
							Effect.fail(unavailable(error)),
						),
					)
				if (joined)
					yield* recordJoin(row.organizationId, { id: account.value.id }, roles)
				return { ...(yield* invitationView(row, now)), status: answer }
			}),
		listBotInvitations: (organizationId, bot, status) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* botInvitationRows(organizationId, bot)
				const views = yield* Effect.forEach(rows, (row) =>
					botInvitationView(row, now),
				)
				return Arr.filter(
					views,
					(invitation) => status === undefined || invitation.status === status,
				)
			}),
		createBotInvitation: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const email =
					input.email === undefined
						? null
						: pipe(input.email, Str.trim, Str.toLowerCase)
				const row: InvitationRow = {
					id: "inv_" + (yield* newId),
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
									return yield* OrganizationsModel.InvitationInvalid.make({
										message: "This email already has a pending invitation.",
									})
							}
							yield* tx.insert(invitations).values(row)
						}),
					)
					.pipe(
						Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
							Effect.fail(unavailable(error)),
						),
					)
				return yield* botInvitationView(row, now)
			}),
		botInvitation: (organizationId, bot, invitationId) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const found = yield* botInvitationRow(organizationId, bot, invitationId)
				if (Option.isNone(found))
					return yield* OrganizationsModel.InvitationNotFound.make({
						invitationId: OrganizationsModel.InvitationId.make(invitationId),
					})
				const row = found.value
				return {
					invitation: yield* botInvitationView(row, now),
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
				const found = yield* botInvitationRow(organizationId, bot, invitationId)
				if (Option.isNone(found))
					return yield* OrganizationsModel.InvitationNotFound.make({
						invitationId: OrganizationsModel.InvitationId.make(invitationId),
					})
				const current = yield* botInvitationView(found.value, now)
				if (current.status !== "pending")
					return yield* OrganizationsModel.InvitationInvalid.make({
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
				const notFound = OrganizationsModel.InvitationNotFound.make({
					...(by._tag === "Email"
						? {
								invitationId: OrganizationsModel.InvitationId.make(
									by.invitationId,
								),
							}
						: {}),
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
					const status = yield* statusOf(row, now)
					if (status !== "pending")
						return yield* OrganizationsModel.InvitationInvalid.make({
							message: `The invitation is ${status}.`,
						})
					return taken
				}
				// An invitation for another email stays hidden.
				const account = yield* accountOf(userId)
				if (Option.isNone(account) || account.value.email !== row.email)
					return yield* notFound
				if (!account.value.emailVerified)
					return yield* OrganizationsModel.InvitationInvalid.make({
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
								locked === undefined ? "revoked" : yield* statusOf(locked, now)
							if (status !== "pending")
								return yield* OrganizationsModel.InvitationInvalid.make({
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
						Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
							Effect.fail(unavailable(error)),
						),
					)
				return taken
			}),
		roleInUse: (organizationId, roleId) =>
			Effect.gen(function* () {
				const current = yield* settings.organization(organizationId)
				if (current.document.defaultRoles.includes(roleId)) return true
				const mapped = yield* db
					.select()
					.from(mappedRoles)
					.where(
						and(
							eq(mappedRoles.organizationId, organizationId),
							eq(mappedRoles.role, roleId),
						),
					)
					.limit(1)
				if (mapped.length > 0) return true
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
