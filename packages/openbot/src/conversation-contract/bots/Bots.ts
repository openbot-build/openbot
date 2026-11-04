import type { Config } from "@openbot-build/core"
import { Bots as BotsApi } from "@openbot-build/domain"
import { type Authorization } from "@openbot-build/domain"
import { type Caller } from "@openbot-build/domain"
import { Context, Effect, Option } from "effect"
import * as Check from "../../identity-contract/authorization/Check.ts"

type Bot = BotsApi.Bot

type BotId = BotsApi.BotId

export type Failure =
	| BotsApi.BotNotFound
	| BotsApi.BotConflict
	| BotsApi.BotInvalid
	| BotsApi.BotStorageUnavailable
	| Check.Errors

/** An action on a Bot, such as `read` or `delegate`. */
export type Action = (typeof Authorization.Bot.actions)[number]

/** The member that work is done for. */
export interface Subject {
	readonly organizationId: string
	readonly userId: string
}

/** The Bots of an organization. */
export class Bots extends Context.Service<
	Bots,
	{
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Bot>, BotsApi.BotStorageUnavailable>
		/**
		 * Reads a Bot and checks that the caller may do the action on it. A caller
		 * who may not read the Bot gets `BotNotFound`.
		 */
		readonly access: (
			caller: Caller,
			id: string,
			action: Action,
		) => Effect.Effect<Bot, Failure>
		readonly list: (
			caller: Caller,
			input: {
				readonly archived?: boolean
				readonly bot?: BotId
			},
		) => Effect.Effect<ReadonlyArray<Bot>, Failure>
		readonly create: (
			caller: Caller,
			input: BotsApi.CreateBotRequest,
		) => Effect.Effect<Bot, Failure>
		/**
		 * Makes a lasting Bot that another Bot owns. A Bot uses it with a tool.
		 * The capability gate checks it first, so it checks no permission itself.
		 */
		readonly createOwned: (
			organizationId: string,
			owner: Bot,
			input: {
				readonly name: string
				readonly role: string
				readonly instructions: string
				readonly model?: Config.Selection
			},
		) => Effect.Effect<Bot, BotsApi.BotStorageUnavailable>
		readonly update: (
			caller: Caller,
			id: string,
			input: BotsApi.UpdateBotRequest,
		) => Effect.Effect<Bot, Failure>
		/**
		 * Lets the caller use a shared Bot: it makes a linked Bot in the organization of the
		 * caller, and makes the caller a member of the shared Bot. A member keeps one linked
		 * Bot. When they already have one, it gives that one back.
		 */
		readonly link: (
			caller: Caller,
			source: { readonly organizationId: string; readonly bot: Bot },
		) => Effect.Effect<Bot, Failure>
		/** The people who use a shared Bot in their own organizations. */
		readonly members: (
			organizationId: string,
			bot: BotId,
		) => Effect.Effect<
			ReadonlyArray<BotsApi.BotMember>,
			BotsApi.BotStorageUnavailable
		>
		/** Takes a person off a shared Bot. Their linked Bot stops working. */
		readonly removeMember: (
			organizationId: string,
			bot: BotId,
			userId: string,
		) => Effect.Effect<boolean, BotsApi.BotStorageUnavailable>
		/**
		 * The deciders of a Bot: its owner chain from the top, ending with the Bot.
		 * The top is a Bot that a member or the organization owns. Archived Bots are left out.
		 * `subject` is the member who works with the Bot now.
		 */
		readonly ownerChain: (
			subject: Subject,
			bot: Bot,
		) => Effect.Effect<ReadonlyArray<BotId>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/conversation-contract/bots/Bots") {}

export { type Bot, type BotId }
