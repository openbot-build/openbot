import type { Triggers } from "@openbot-build/domain"
/**
 * The names of resources in the audit log, such as
 * `openbot.org.<org>.user.<user>.bot.<id>`. They are only labels. The
 * policies in `../authorization` decide who may do what.
 */
import type {
	Bots as BotsModel,
	Computers as ComputersModel,
	Vaults as VaultsModel,
} from "@openbot-build/domain"
import { pipe, String as Str } from "effect"
import { rootOf } from "../authorization/Resources.ts"

/** IDs go into dotted names, so a dot in an ID must not look like a new part. */
export const segment = (id: string) =>
	pipe(encodeURIComponent(id), Str.replaceAll(".", "%2E"))

export interface Subject {
	readonly organizationId: string
	readonly userId: string
}

/** The name of the whole deployment. */
export const platformKey = "openbot.platform"

export const organizationKey = (organizationId: string) =>
	"openbot.org." + segment(organizationId)
export const userKey = (subject: Subject) =>
	organizationKey(subject.organizationId) + ".user." + segment(subject.userId)

/** The place for the Bots of a member, or for shared Bots when `root` is `null`. */
export const botPlace = ({
	organizationId,
	root,
}: {
	readonly organizationId: string
	readonly root: string | null
}) =>
	(root === null
		? organizationKey(organizationId)
		: userKey({ organizationId, userId: root })) + ".bot"

/**
 * The key of one Bot. Shared Bots, and the Bots below them, are below the organization.
 * The other Bots are below the member at the top of their owner tree.
 */
export const botKey = (bot: {
	readonly organizationId: string
	readonly id: string
	readonly owner: BotsModel.BotOwner
}) =>
	botPlace({
		organizationId: bot.organizationId,
		root: rootOf(bot.owner),
	}) +
	"." +
	segment(bot.id)

/** The place for the triggers of a member, or for shared triggers when `userId` is `null`. */
export const triggerPlace = (input: {
	readonly organizationId: string
	readonly userId: string | null
}) =>
	(input.userId === null
		? organizationKey(input.organizationId)
		: userKey({ organizationId: input.organizationId, userId: input.userId })) +
	".trigger"

/** The key of one trigger. */
export const triggerKey = (trigger: {
	readonly organizationId: string
	readonly id: string
	readonly owner: Triggers.TriggerOwner
}) =>
	triggerPlace({
		organizationId: trigger.organizationId,
		userId: trigger.owner._tag === "Member" ? trigger.owner.userId : null,
	}) +
	"." +
	segment(trigger.id)

/**
 * The place for the Computers of a member, or for shared Computers when `userId` is `null`.
 * `kind` is `computer` or `computer_provider`.
 */
export const computerPlace = (input: {
	readonly organizationId: string
	readonly userId: string | null
	readonly kind: "computer" | "computer_provider"
}) =>
	(input.userId === null
		? organizationKey(input.organizationId)
		: userKey({ organizationId: input.organizationId, userId: input.userId })) +
	"." +
	input.kind

/** The key of one Computer or Computer provider. */
export const computerKey = (input: {
	readonly organizationId: string
	readonly id: string
	readonly owner: ComputersModel.ComputerOwner
	readonly kind: "computer" | "computer_provider"
}) =>
	computerPlace({
		organizationId: input.organizationId,
		userId: input.owner._tag === "Member" ? input.owner.userId : null,
		kind: input.kind,
	}) +
	"." +
	segment(input.id)

/** The key of one Vault. Its items and their rights go under it. */
export const vaultKey = (vault: {
	readonly organizationId: string
	readonly id: string
	readonly owner: VaultsModel.VaultOwner
}) =>
	(vault.owner._tag === "Member"
		? userKey({
				organizationId: vault.organizationId,
				userId: vault.owner.userId,
			})
		: organizationKey(vault.organizationId)) +
	".vault." +
	segment(vault.id)

/** The key of one secret provider. */
export const secretProviderKey = (provider: {
	readonly organizationId: string
	readonly id: string
	readonly owner: VaultsModel.VaultOwner
}) =>
	(provider.owner._tag === "Member"
		? userKey({
				organizationId: provider.organizationId,
				userId: provider.owner.userId,
			})
		: organizationKey(provider.organizationId)) +
	".secret_provider." +
	segment(provider.id)
