import type { Services as AuthorizationServices } from "../authorization/Check.ts"
import {
	Account,
	BotsApi,
	type Caller,
	Identity,
	OrganizationApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import { botKey } from "../audit/Resources.ts"
import { Grants } from "../capabilities/Grants.ts"
import { Rules } from "../capabilities/Rules.ts"
import { BotMemories, homeOf } from "./BotMemories.ts"
import { MemoryBot } from "./MemoryBot.ts"
import { Organization } from "../organization/Organization.ts"
import { Bots } from "./Bots.ts"
import * as InvitationLinks from "./InvitationLinks.ts"
import { shareable } from "./Sharing.ts"

export const layer = (publicOrigin: string) =>
	HttpApiBuilder.group(OpenBotApi, "bots", (handlers) =>
		Effect.gen(function* () {
			const bots = yield* Bots
			const memories = yield* BotMemories
			const memoryBot = yield* MemoryBot
			const rules = yield* Rules
			const grants = yield* Grants
			const audit = yield* AuditLog
			const organization = yield* Organization
			const services = yield* Effect.context<
				AuthorizationServices | Effect.Services<typeof InvitationLinks.make>
			>()
			const access = (
				caller: Caller,
				id: string,
				permission: "read" | "write" | "share",
			) =>
				bots
					.access(caller, id, permission)
					.pipe(Effect.provideContext(services))
			const record = (
				caller: Caller,
				action: OrganizationApi.AuditAction,
				bot: BotsApi.Bot,
				details: Schema.JsonObject,
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource: botKey({
							...bot,
							organizationId: caller.organizationId,
						}),
						details,
					})
					.pipe(Effect.mapError(() => BotsApi.BotStorageUnavailable.make({})))
			/**
			 * The memory pool of a Bot, as the caller sees it. Each person reads only the
			 * entries for them, in their own organization. Nobody reads another person's memory.
			 */
			const memoryOf = (caller: Caller, id: string) =>
				Effect.gen(function* () {
					const bot = yield* access(caller, id, "read")
					return {
						bot,
						home: homeOf(caller.organizationId, bot),
						viewer: {
							organizationId: caller.organizationId,
							person: caller.userId,
						},
					}
				})
			/** The memory Bot and the purge belong to the people of the Bot, not to its members. */
			const ownMemory = (caller: Caller, id: string) =>
				Effect.gen(function* () {
					const bot = yield* access(caller, id, "write")
					if (bot.source !== undefined)
						return yield* BotsApi.BotInvalid.make({
							message:
								"This Bot is shared with you. Only its own people manage its memory.",
						})
					return { bot, home: homeOf(caller.organizationId, bot) }
				})
			return handlers
				.handle("listBots", ({ query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						return yield* bots
							.list(caller, {
								...(query.archived === undefined
									? {}
									: { archived: query.archived === "true" }),
								...(query.bot === undefined ? {} : { bot: query.bot }),
							})
							.pipe(Effect.provideContext(services))
					}),
				)
				.handle("createBot", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* bots
							.create(caller, payload)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "bot.created", bot, {
							name: bot.name,
							shared: bot.owner._tag === "Organization",
						})
						return bot
					}),
				)
				.handle("getBot", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						access(caller, params.botId, "read"),
					),
				)
				.handle("updateBot", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* bots
							.update(caller, params.botId, payload)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "bot.updated", bot, {
							revision: bot.revision,
						})
						return bot
					}),
				)
				.handle("botMemory", ({ params, query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { home, viewer } = yield* memoryOf(caller, params.botId)
						const tags =
							query.tags === undefined
								? []
								: query.tags
										.split(",")
										.map((tag) => tag.trim())
										.filter((tag) => tag.length > 0)
						return yield* memories.view(home, viewer, tags)
					}),
				)
				.handle("updateBotMemory", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { bot, home } = yield* memoryOf(caller, params.botId)
						const view = yield* memories.edit(
							home,
							{ userId: caller.userId, organizationId: caller.organizationId },
							payload.command,
						)
						yield* record(caller, "bot.memory.updated", bot, {
							command: payload.command._tag,
							...(payload.command._tag === "Forget"
								? { id: payload.command.id }
								: {}),
						})
						return view
					}),
				)
				.handle("botMemoryLog", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { home, viewer } = yield* memoryOf(caller, params.botId)
						return yield* memories.log(home, viewer)
					}),
				)
				.handle("purgeBotMemory", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { bot, home } = yield* ownMemory(caller, params.botId)
						const removed = yield* memories.purge(home, payload.tag)
						yield* record(caller, "bot.memory.purged", bot, {
							tag: payload.tag,
							removed,
						})
						return { removed }
					}),
				)
				.handle("memoryBot", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { home } = yield* ownMemory(caller, params.botId)
						return yield* memoryBot.settings(home)
					}),
				)
				.handle("updateMemoryBot", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { bot, home } = yield* ownMemory(caller, params.botId)
						const settings = yield* memoryBot.update(home, payload)
						yield* record(caller, "bot.memory_bot.updated", bot, {
							revision: settings.revision,
						})
						return settings
					}),
				)
				.handle("listRules", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "read")
						return yield* rules.list(caller.organizationId, bot.id)
					}),
				)
				.handle("createRule", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "write")
						const rule = yield* rules.create(caller.organizationId, {
							bot: bot.id,
							author: { _tag: "Person", userId: caller.userId },
							text: payload.text,
							status: "active",
						})
						yield* record(caller, "rule.created", bot, { rule: rule.id })
						return rule
					}),
				)
				.handle("updateRule", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "write")
						const rule = yield* rules.update(
							caller.organizationId,
							bot.id,
							params.ruleId,
							payload,
						)
						yield* record(caller, "rule.updated", bot, {
							rule: rule.id,
							status: rule.status,
							version: rule.version,
						})
						return rule
					}),
				)
				.handle("listGrants", ({ params, query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "read")
						return yield* grants.list(
							caller.organizationId,
							bot.id,
							query.status,
						)
					}),
				)
				.handle("createGrant", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "write")
						if (payload.scope === "chat")
							return yield* BotsApi.BotInvalid.make({
								message:
									"A person gives a Chat Grant by answering a request in that Chat.",
							})
						const grant = yield* grants.create(caller.organizationId, {
							bot: bot.id,
							capability: payload.capability,
							effect: payload.effect,
							scope: payload.scope,
							grantedBy: { _tag: "Person", userId: caller.userId },
							...(payload.reason === undefined
								? {}
								: { reason: payload.reason }),
						})
						yield* record(caller, "grant.created", bot, {
							grant: grant.id,
							effect: grant.effect,
						})
						return grant
					}),
				)
				.handle("revokeGrant", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "write")
						const revoked = yield* grants.revoke(
							caller.organizationId,
							bot.id,
							params.grantId,
						)
						yield* record(caller, "grant.revoked", bot, {
							grants: revoked.map((grant) => grant.id),
						})
					}),
				)
				.handle("listBotMembers", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "share")
						return yield* bots.members(caller.organizationId, bot.id)
					}),
				)
				.handle("removeBotMember", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "share")
						const removed = yield* bots.removeMember(
							caller.organizationId,
							bot.id,
							params.userId,
						)
						if (!removed)
							return yield* BotsApi.BotNotFound.make({ bot: bot.id })
						yield* record(caller, "bot_member.removed", bot, {
							userId: params.userId,
						})
					}),
				)
				.handle("createBotInvitation", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "share")
						if (!shareable(bot))
							return yield* BotsApi.BotInvalid.make({
								message:
									"Only a lasting top Bot of this organization that is not archived can be shared.",
							})
						const made =
							payload.email === undefined
								? Option.some(
										yield* InvitationLinks.make.pipe(
											Effect.provideContext(services),
											Effect.mapError(() =>
												BotsApi.BotStorageUnavailable.make({}),
											),
										),
									)
								: Option.none()
						const invitation = yield* organization
							.createBotInvitation({
								organizationId: caller.organizationId,
								bot: { id: bot.id, name: bot.name },
								invitedBy: caller.userId,
								...(payload.email === undefined
									? {}
									: { email: payload.email }),
								...(payload.expiresAt === undefined
									? {}
									: { expiresAt: payload.expiresAt }),
								...(payload.path === undefined ? {} : { path: payload.path }),
								...Option.match(made, {
									onNone: () => ({}),
									onSome: (made) => ({ link: made.link }),
								}),
							})
							.pipe(
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? BotsApi.BotStorageUnavailable.make({})
										: error,
								),
							)
						yield* record(caller, "invitation.created", bot, {
							invitationId: invitation.id,
							target: "bot",
							...(invitation.email === null ? {} : { email: invitation.email }),
						})
						const secret = Option.match(made, {
							onNone: () => null,
							onSome: (made) => made.secret,
						})
						return {
							invitation,
							secret,
							url: InvitationLinks.urlOf(publicOrigin, invitation.path, secret),
						}
					}),
				)
				.handle("listBotInvitations", ({ params, query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "share")
						return yield* organization
							.listBotInvitations(caller.organizationId, bot.id, query.status)
							.pipe(
								Effect.mapError(() => BotsApi.BotStorageUnavailable.make({})),
							)
					}),
				)
				.handle("botInvitationSecret", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "share")
						const { invitation, link } = yield* organization
							.botInvitation(caller.organizationId, bot.id, params.invitationId)
							.pipe(
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? BotsApi.BotStorageUnavailable.make({})
										: error,
								),
							)
						const secret =
							link === null
								? null
								: yield* InvitationLinks.open(link).pipe(
										Effect.provideContext(services),
										Effect.mapError(() =>
											BotsApi.BotStorageUnavailable.make({}),
										),
									)
						return {
							invitation,
							secret,
							url: InvitationLinks.urlOf(publicOrigin, invitation.path, secret),
						}
					}),
				)
				.handle("revokeBotInvitation", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* access(caller, params.botId, "share")
						const invitation = yield* organization
							.revokeBotInvitation(
								caller.organizationId,
								bot.id,
								params.invitationId,
							)
							.pipe(
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? BotsApi.BotStorageUnavailable.make({})
										: error,
								),
							)
						yield* record(caller, "invitation.revoked", bot, {
							invitationId: invitation.id,
							target: "bot",
						})
					}),
				)
		}),
	)

/** A person accepts an invitation to use a Bot, in an organization of their own. */
export const layerInvitations = HttpApiBuilder.group(
	OpenBotApi,
	"botInvitations",
	(handlers) =>
		Effect.gen(function* () {
			const bots = yield* Bots
			const organization = yield* Organization
			const audit = yield* AuditLog
			const services = yield* Effect.context<AuthorizationServices>()
			return handlers.handle("acceptBotInvitation", ({ payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const by =
						payload.invitation !== undefined
							? ({ _tag: "Email", invitationId: payload.invitation } as const)
							: payload.secret !== undefined
								? ({
										_tag: "Link",
										secretHash: InvitationLinks.hashOf(payload.secret),
									} as const)
								: undefined
					if (by === undefined)
						return yield* OrganizationApi.InvitationInvalid.make({
							message: "Send `invitation` or `secret`.",
						})
					// The organization where the person uses the Bot. They name it, a user
					// token names it, or it is their only organization.
					const memberships = yield* organization
						.memberships(account.userId)
						.pipe(Effect.mapError(() => BotsApi.BotStorageUnavailable.make({})))
					const chosen =
						payload.organization ??
						account.organizationId ??
						(memberships.length === 1
							? memberships[0]?.organizationId
							: undefined)
					if (chosen === undefined)
						return yield* OrganizationApi.InvitationInvalid.make({
							message:
								"Name the organization where you use the Bot in `organization`.",
						})
					const active = yield* organization
						.activeMember(chosen, account.userId)
						.pipe(Effect.mapError(() => BotsApi.BotStorageUnavailable.make({})))
					if (Option.isNone(active))
						return yield* OrganizationApi.InvitationInvalid.make({
							message:
								"You must be an active member of the organization where you use the Bot.",
						})
					const taken = yield* organization
						.takeBotInvitation(account.userId, by)
						.pipe(
							Effect.mapError((error) =>
								error._tag === "OrganizationUnavailable"
									? BotsApi.BotStorageUnavailable.make({})
									: error,
							),
						)
					const source = yield* bots.find(taken.organizationId, taken.bot)
					if (Option.isNone(source) || !shareable(source.value))
						return yield* OrganizationApi.InvitationInvalid.make({
							message: "This Bot is not shared any more.",
						})
					const caller: Caller = {
						kind: "member",
						organizationId: chosen,
						userId: account.userId,
					}
					const linked = yield* bots
						.link(caller, {
							organizationId: taken.organizationId,
							bot: source.value,
						})
						.pipe(Effect.provideContext(services))
					const actor: Caller = {
						kind: "member",
						organizationId: taken.organizationId,
						userId: account.userId,
					}
					yield* audit
						.record({
							organizationId: taken.organizationId,
							action: "bot_member.joined",
							actor,
							resource: botKey({
								...source.value,
								organizationId: taken.organizationId,
							}),
							details: {
								invitationId: taken.invitationId,
								organizationId: chosen,
							},
						})
						.pipe(Effect.mapError(() => BotsApi.BotStorageUnavailable.make({})))
					return linked
				}),
			)
		}),
)
