import { assert, describe, it } from "@effect/vitest"
import {
	Authorization,
	type Caller,
	Identity,
	TriggersApi,
} from "@openbot-build/api"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Effect } from "effect"
import * as Check from "../src/authorization/Check.ts"
import { triggerResource } from "../src/authorization/Resources.ts"
import * as Policies from "./Policies.ts"

const organizationId = "org_checks"
const alice: Caller = { kind: "member", organizationId, userId: "alice" }
const bob: Caller = { kind: "member", organizationId, userId: "bob" }

const triggerOf = (userId: string) =>
	triggerResource({
		organizationId,
		id: "trg_" + userId,
		owner: { _tag: "Member", userId },
	})
const aliceTrigger = triggerOf("alice")
const bobTrigger = triggerOf("bob")

/** An authorizer that gives each member every act on their own things. */
const layerOwnOnly = Authorizer.layer(Authorization.Auth, {
	principal: Identity,
	policy: () =>
		Effect.succeed(
			Policy.define(Authorization.OpenBot)(function* (_) {
				yield* _.allow("*", "*", Policies.own)
			}),
		),
	cache: false,
})

/** An authorizer that gives every act to everyone. */
const layerEverything = Authorizer.layer(Authorization.Auth, {
	principal: Identity,
	policy: () =>
		Effect.succeed(
			Policy.define(Authorization.OpenBot)(function* (_) {
				yield* _.allow("*", "*")
			}),
		),
	cache: false,
})

/** The checks, made once with the own-things authorizer, as a layer makes them. */
const checks = Check.make.pipe(Effect.provide(layerOwnOnly))

describe("Check", () => {
	it.effect("the checks need no services when they run", () =>
		Effect.gen(function* () {
			const { check } = yield* checks
			yield* check(alice, { action: "write", resource: aliceTrigger })
			const denied = yield* Effect.flip(
				check(alice, { action: "write", resource: bobTrigger }),
			)
			assert.strictEqual(denied._tag, "Forbidden")
		}),
	)

	it.effect("the checks keep the authorizer of the time they were made", () =>
		Effect.gen(function* () {
			const { allows } = yield* checks
			// Another authorizer in the context of the call does not change the answer.
			const answer = yield* allows(alice, {
				action: "read",
				resource: bobTrigger,
			}).pipe(Effect.provide(layerEverything))
			assert.isFalse(answer)
		}),
	)

	it.effect("each call checks its own caller", () =>
		Effect.gen(function* () {
			const { allows } = yield* checks
			const answers = yield* Effect.all(
				[
					allows(alice, { action: "read", resource: aliceTrigger }),
					allows(bob, { action: "read", resource: aliceTrigger }),
					allows(bob, { action: "read", resource: bobTrigger }),
				],
				{ concurrency: "unbounded" },
			)
			assert.deepStrictEqual(answers, [true, false, true])
		}),
	)

	it.effect("guard hides a resource that the caller may not read", () =>
		Effect.gen(function* () {
			const { guard } = yield* checks
			const hidden = TriggersApi.TriggerNotFound.make({ id: bobTrigger.id })
			const error = yield* Effect.flip(
				guard(
					alice,
					{ action: "write", resource: bobTrigger },
					{ hide: () => hidden },
				),
			)
			assert.strictEqual(error, hidden)
			yield* guard(
				alice,
				{ action: "write", resource: aliceTrigger },
				{ hide: () => hidden },
			)
		}),
	)

	it.effect("filter gives the values that the caller may read", () =>
		Effect.gen(function* () {
			const { filter } = yield* checks
			const readable = yield* filter(alice, { action: "read", kind: "Trigger" })
			assert.isTrue(Check.matches(readable, aliceTrigger))
			assert.isFalse(Check.matches(readable, bobTrigger))
		}),
	)
})
