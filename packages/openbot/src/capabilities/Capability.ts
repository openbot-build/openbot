import { createHash } from "node:crypto"
import {
	Authorization,
	type BotsApi,
	type Caller,
	type ComputersApi,
} from "@openbot-build/api"
import type { Authorizer } from "@nmnmcc/ability"
import {
	botResource,
	computerProviderResource,
	computerResource,
	rootOf,
} from "../authorization/Resources.ts"

export type Capability = BotsApi.Capability

/** A short and stable text that names a capability, for logs, prompts and cache keys. */
export const describe = (capability: Capability) =>
	capability.action +
	" " +
	capability.target +
	(capability.arguments === undefined
		? ""
		: " " + JSON.stringify(capability.arguments))

export const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40)

/**
 * The act of the member that a capability needs. A Bot never does more than
 * the member it works for, so this check comes first.
 */
export const memberTarget = (input: {
	readonly caller: Caller
	readonly capability: Capability
	readonly chat: string
	/** The target Bot, for actions on a Bot. */
	readonly bot?: BotsApi.Bot
	/** The Bot that tries the action. The Bots it makes go below its owner tree. */
	readonly self: BotsApi.Bot
	/**
	 * The owner of the target Computer, or of the Computer provider for `computers.create`.
	 * Without it, OpenBot uses the member as the owner, so a shared target is denied.
	 */
	readonly computerOwner?: ComputersApi.ComputerOwner
}): Authorizer.Target<Authorization.OpenBot> => {
	const organizationId = input.caller.organizationId
	const userId = input.caller.userId
	const personal: ComputersApi.ComputerOwner = { _tag: "Member", userId }
	switch (input.capability.action) {
		case "apps.call":
			return {
				action: "use",
				resource: Authorization.App.make({
					organizationId,
					ownerUserId: userId,
				}),
			}
		case "bots.create":
			return {
				action: "write",
				kind: "Bot",
				within: ($) =>
					$.and(
						$.eq("organizationId", organizationId),
						$.eq("ownerUserId", rootOf(input.self.owner)),
					),
			}
		case "bots.delegate":
			return input.bot === undefined
				? {
						action: "delegate",
						kind: "Bot",
						within: ($) =>
							$.and(
								$.eq("organizationId", organizationId),
								$.eq("ownerUserId", null),
							),
					}
				: {
						action: "delegate",
						resource: botResource({ ...input.bot, organizationId }),
					}
		// Carrying out a plan, or going on after a limit, is work in the Chat, like a tool call.
		case "plans.run":
		case "delegations.continue":
		case "tools.call":
			return {
				action: "run",
				resource: Authorization.Chat.make({
					organizationId,
					ownerUserId: userId,
					id: input.chat,
				}),
			}
		// A Bot makes a Computer with an account at a provider, for its member.
		case "computers.create":
			return {
				action: "use",
				resource: computerProviderResource({
					organizationId,
					id: input.capability.target,
					owner: input.computerOwner ?? personal,
				}),
			}
		// The Bot can only get or use a Computer that its member can use.
		case "computers.acquire":
		case "computers.expose":
		case "computers.delete":
			return {
				action:
					input.capability.action === "computers.delete" ? "write" : "use",
				resource: computerResource({
					organizationId,
					id: input.capability.target,
					owner: input.computerOwner ?? personal,
				}),
			}
		// Posting to a Channel needs the same act as talking in it.
		case "channels.send":
			return {
				action: "use",
				resource: Authorization.Channel.make({
					organizationId,
					id: input.capability.target,
				}),
			}
	}
}
