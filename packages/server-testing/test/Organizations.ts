import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Caller from "./Caller.ts"
import type { Send } from "./DefaultBot.ts"

const Organization = Schema.Struct({ id: Schema.String })
const Listed = Schema.Struct({ items: Schema.Array(Organization) })

/**
 * Makes an organization for the account when it has none, like a new person does.
 * OpenBot never makes one at sign-in. Answers the ID of the first organization.
 */
export const ensure = Effect.fn("Organizations.ensure")(function* (send: Send) {
	const listed = yield* Effect.flatMap(
		send("/v1/organizations", "GET"),
		Caller.json(Listed),
	)
	const first = Arr.head(listed.items)
	if (Option.isSome(first)) return first.value.id
	const created = yield* Effect.flatMap(
		send("/v1/organizations", "POST", { name: "Test" }),
		Caller.json(Organization),
	)
	return created.id
})
