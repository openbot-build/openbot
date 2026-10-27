import { type Computers as ComputersApi } from "@openbot-build/domain"
import { type Bots as BotsApi } from "@openbot-build/domain"
import { Authorization } from "@openbot-build/domain"
import { type ExecutionIdentity } from "@openbot-build/domain"
import type { Authorizer } from "@nmnmcc/ability"
import { Crypto, Effect, Schema, String as Str } from "effect"
import { Hex } from "effect/encoding"
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

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** A short and stable SHA-256 text of a JSON value, for IDs and cache keys. */
export const hash = (crypto: Crypto.Crypto, value: unknown) =>
	Effect.gen(function* () {
		const text = yield* encodeJson(value)
		const digest = yield* crypto.digest(
			"SHA-256",
			new TextEncoder().encode(text),
		)
		return Str.slice(0, 40)(Hex.encode(digest))
	}).pipe(
		// The value is JSON data and SHA-256 is always there, so a failure here is a defect.
		Effect.orDie,
	)

/**
 * The act of the member that a capability needs. A Bot never does more than
 * the member it works for, so this check comes first.
 */
export const memberTarget = (input: {
	readonly owner: ExecutionIdentity["owner"]
	readonly channel?: NonNullable<ExecutionIdentity["channel"]>
	readonly capability: Capability
	readonly chat: string
	/** The target Bot, for actions on a Bot. */
	readonly bot?: BotsApi.Bot
	/** The Bot that tries the action. The Bots it makes go below its owner tree. */
	readonly self: BotsApi.Bot
	/**
	 * The owner of the target Computer, or of the Computer provider for `computers.create`.
	 * Without it, OpenBot uses the owner of the work, so a shared target is denied.
	 */
	readonly computerOwner?: ComputersApi.ComputerOwner
}): Authorizer.Target<Authorization.OpenBot> => {
	const { organizationId, userId } = input.owner
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
			// Channel work uses the Channel's rights. Its stored Chat belongs to its owner.
			if (input.channel !== undefined)
				return {
					action: "use",
					resource: Authorization.Channel.make({
						organizationId,
						id: input.channel.id,
					}),
				}
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
