/**
 * An authorizer service in an Effect program.
 *
 * - The principal comes from the `Identity` service of the request.
 * - The policy of each principal is loaded once and kept in a cache.
 * - `guard` answers "not found" when the principal may not see the Bot.
 * - The decider answers when no rule does. Here it says "wait": a person must
 *   say yes first.
 */
import { Context, Effect, Schema } from "effect"
import {
	Authorizer,
	Decision,
	Domain,
	Policy,
	Principal,
	Resource,
} from "../src/index.ts"

class Caller extends Principal.Class<Caller>("Caller")({
	userId: Schema.String,
}) {}

class Bot extends Resource.Class<Bot>()("Bot", {
	actions: ["read", "update", "delegate"],
	fields: {
		id: Schema.String,
		ownerUserId: Schema.String,
		team: Schema.String,
	},
}) {}

const App = Domain.make({ principal: Caller, resources: [Bot] })

class Identity extends Context.Service<Identity, Caller>()(
	"@nmnmcc/ability/examples/authorizer/Identity",
) {}

class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
	"@nmnmcc/ability/examples/authorizer/Auth",
	App,
) {}

class BotNotFound extends Schema.TaggedError<BotNotFound>()("BotNotFound", {
	id: Schema.String,
}) {}

const AuthLive = Authorizer.layer(Auth, {
	principal: Identity,
	policy: () =>
		Effect.succeed(
			Policy.define(App)(function* (_) {
				yield* _.allow("read", Bot, { when: ($) => $.eq("team", "core") })
				yield* _.allow("update", Bot, {
					when: ($) => $.eq("ownerUserId", $.principal("userId")),
				})
			}),
		),
	decider: (request) =>
		request.action === "delegate"
			? Effect.fail(Authorizer.Pending.make({ ticket: "request-1" }))
			: Effect.succeed(Decision.NotApplicable),
})

const answer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.as("yes"),
		Effect.catch((error) =>
			Effect.succeed(
				typeof error === "object" && error !== null && "_tag" in error
					? String(error._tag)
					: "error",
			),
		),
	)

const own = Bot.make({ id: "b1", ownerUserId: "u1", team: "core" })
const other = Bot.make({ id: "b2", ownerUserId: "u2", team: "core" })
const hidden = Bot.make({ id: "b3", ownerUserId: "u2", team: "secret" })

const program = Effect.gen(function* () {
	return {
		updateOwn: yield* answer(Auth.check({ action: "update", resource: own })),
		updateOther: yield* answer(
			Auth.guard(
				{ action: "update", resource: other },
				{ hide: () => BotNotFound.make({ id: other.id }) },
			),
		),
		updateHidden: yield* answer(
			Auth.guard(
				{ action: "update", resource: hidden },
				{ hide: () => BotNotFound.make({ id: hidden.id }) },
			),
		),
		delegate: yield* answer(Auth.check({ action: "delegate", resource: own })),
	}
}).pipe(
	Effect.provideService(Identity, Caller.make({ userId: "u1" })),
	// This is the entry point of the program, so it gives the layer here.
	// @effect-diagnostics-next-line strictEffectProvide:off
	Effect.provide(AuthLive),
)

console.log(Effect.runSync(program))
