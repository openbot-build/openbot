import { assert, describe, it } from "@effect/vitest"
import { BotsApi } from "@openbot-build/api"
import { Chat } from "@openbot-build/core"
import { Effect, Option } from "effect"
import { decidingGrant } from "../src/capabilities/Policy.ts"

const bot = BotsApi.BotId.make("bot_1")
const here = Chat.Id.make("chat_here")
const there = Chat.Id.make("chat_there")

const grant = (
	id: string,
	input: {
		readonly effect: "allow" | "deny"
		readonly target?: string
		readonly arguments?: Record<string, string>
		readonly scope?: BotsApi.Grant["scope"]
		readonly chat?: Chat.Id
	},
): BotsApi.Grant => ({
	id,
	bot,
	capability: {
		action: "tools.call",
		target: input.target ?? "search",
		...(input.arguments === undefined ? {} : { arguments: input.arguments }),
	},
	effect: input.effect,
	scope: input.scope ?? "lifetime",
	...(input.chat === undefined ? {} : { chat: input.chat }),
	grantedBy: { _tag: "Person", userId: "user_1" },
	status: "active",
	createdAt: 1,
})

const decide = (
	grants: ReadonlyArray<BotsApi.Grant>,
	capability: BotsApi.Capability = { action: "tools.call", target: "search" },
	chat: Chat.Id = here,
) =>
	Option.map(
		Effect.runSync(decidingGrant({ grants, bot, capability, chat })),
		(found) => found.id,
	)

describe("The Grants of a Bot", () => {
	it("let a deny Grant win, in any order", () => {
		const allow = grant("grt_allow", { effect: "allow" })
		const deny = grant("grt_deny", { effect: "deny" })
		assert.deepStrictEqual(decide([allow, deny]), Option.some("grt_deny"))
		assert.deepStrictEqual(decide([deny, allow]), Option.some("grt_deny"))
	})

	it("give the first allow Grant that covers the request", () => {
		const other = grant("grt_other", { effect: "allow", target: "mail" })
		const any = grant("grt_any", { effect: "allow", target: "*" })
		assert.deepStrictEqual(decide([other, any]), Option.some("grt_any"))
		assert.deepStrictEqual(decide([other]), Option.none())
		assert.deepStrictEqual(
			decide([any], { action: "apps.call", target: "search" }),
			Option.none(),
		)
	})

	it("match arguments exactly, and no arguments match any", () => {
		const exact = grant("grt_exact", {
			effect: "allow",
			arguments: { query: "rome" },
		})
		const free = grant("grt_free", { effect: "allow" })
		const asking = (query: string): BotsApi.Capability => ({
			action: "tools.call",
			target: "search",
			arguments: { query },
		})
		assert.deepStrictEqual(
			decide([exact], asking("rome")),
			Option.some("grt_exact"),
		)
		assert.deepStrictEqual(decide([exact], asking("paris")), Option.none())
		assert.deepStrictEqual(
			decide([free], asking("paris")),
			Option.some("grt_free"),
		)
	})

	it("count a Chat Grant only in its own Chat", () => {
		const chat = grant("grt_chat", {
			effect: "allow",
			scope: "chat",
			chat: here,
		})
		assert.deepStrictEqual(decide([chat]), Option.some("grt_chat"))
		assert.deepStrictEqual(decide([chat], undefined, there), Option.none())
	})
})
