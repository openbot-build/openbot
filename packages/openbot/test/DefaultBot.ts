import { Effect, Schema } from "effect"
import * as Caller from "./Caller.ts"

/** Sends one request with the credential of a person. */
export type Send = (
	path: string,
	method: "GET" | "POST" | "PATCH",
	payload?: unknown,
) => Caller.Call

const MemberSettings = Schema.Struct({
	version: Schema.Finite,
	defaultBot: Schema.NullOr(Schema.String),
})
const Created = Schema.Struct({ id: Schema.String })

/**
 * Makes a Bot and sets it as the default Bot of the person, when they have none.
 * Answers the ID of the default Bot.
 */
export const ensure = Effect.fn("DefaultBot.ensure")(function* (send: Send) {
	const settings = yield* Effect.flatMap(
		send("/v1/me/settings", "GET"),
		Caller.json(MemberSettings),
	)
	if (settings.defaultBot !== null) return settings.defaultBot
	const bot = yield* Effect.flatMap(
		send("/v1/bots", "POST", {
			name: "Assistant",
			role: "Helps one person",
			instructions: "Help the person.",
		}),
		Caller.json(Created),
	)
	yield* Effect.flatMap(
		send("/v1/me/settings", "PATCH", {
			expectedVersion: settings.version,
			defaultBot: bot.id,
		}),
		Caller.json(Schema.Unknown),
	)
	return bot.id
})
