import { createHash } from "node:crypto"
import {
	type BotsApi,
	type Caller,
	type ComputersApi,
	type Permissions,
} from "@openbot-build/api"
import { Option } from "effect"
import {
	botKey,
	botPlace,
	computerKey,
	resourceKey,
	rootOf,
} from "../authorization/Policy.ts"

export type Capability = BotsApi.Capability

/**
 * True when a stored capability covers a request.
 * The target `*` covers every target. Stored arguments must match exactly, and no arguments match any.
 */
export const covers = ({
	stored,
	request,
}: {
	readonly stored: Capability
	readonly request: Capability
}) =>
	stored.action === request.action &&
	(stored.target === "*" || stored.target === request.target) &&
	(stored.arguments === undefined ||
		JSON.stringify(stored.arguments) ===
			JSON.stringify(request.arguments ?? {}))

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
 * The member permission that a capability needs, and its resource key.
 * A Bot never does more than the member it works for, so this check comes first.
 */
export const permission = (input: {
	readonly caller: Caller
	readonly capability: Capability
	readonly chat: string
	/** The target Bot, for actions on a Bot. */
	readonly bot?: BotsApi.Bot
	/** The Bot that tries the action. The Bots it makes go below its owner tree. */
	readonly self: BotsApi.Bot
	/**
	 * The owner of the target Computer, or of the Computer provider for `computers.create`.
	 * Without it, OpenBot uses the place of the member, so a shared target is denied.
	 */
	readonly computerOwner?: ComputersApi.ComputerOwner
}): {
	readonly permission: Permissions.PermissionGroupId
	readonly key: string
} => {
	const subject = {
		organizationId: input.caller.organizationId,
		userId: input.caller.userId,
	}
	const personal: ComputersApi.ComputerOwner = {
		_tag: "Member",
		userId: subject.userId,
	}
	const onBot = (permission: Permissions.PermissionGroupId) => ({
		permission,
		key:
			input.bot === undefined
				? resourceKey({ subject, kind: "bot", id: Option.none() })
				: botKey({ ...input.bot, organizationId: subject.organizationId }),
	})
	switch (input.capability.action) {
		case "apps.call":
			return {
				permission: "apps.use",
				key: resourceKey({ subject, kind: "apps", id: Option.none() }),
			}
		case "bots.create":
			return {
				permission: "bots.write",
				key: botPlace({
					organizationId: subject.organizationId,
					root: rootOf(input.self.owner),
				}),
			}
		case "bots.delegate":
			return onBot("bots.delegate")
		// Carrying out a plan is work in the Chat, like a tool call.
		case "plans.run":
		case "tools.call":
			return {
				permission: "responses.run",
				key: resourceKey({
					subject,
					kind: "chat",
					id: Option.some(input.chat),
				}),
			}
		// A Bot makes a Computer with an account at a provider, for its member.
		case "computers.create":
			return {
				permission: "computer_providers.use",
				key: computerKey({
					organizationId: subject.organizationId,
					id: input.capability.target,
					owner: input.computerOwner ?? personal,
					kind: "computer_provider",
				}),
			}
		// The Bot can only get or use a Computer that its member can use.
		case "computers.acquire":
		case "computers.expose":
		case "computers.delete":
			return {
				permission:
					input.capability.action === "computers.delete"
						? "computers.write"
						: "computers.use",
				key: computerKey({
					organizationId: subject.organizationId,
					id: input.capability.target,
					owner: input.computerOwner ?? personal,
					kind: "computer",
				}),
			}
		// Posting to a Channel needs the same permission as talking in it.
		case "channels.send":
			return {
				permission: "channels.use",
				key: resourceKey({
					subject,
					kind: "channel",
					id: Option.some(input.capability.target),
				}),
			}
	}
}
