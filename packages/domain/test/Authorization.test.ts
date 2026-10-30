import { assert, it } from "@effect/vitest"
import { Policy } from "@nmnmcc/ability"
import { Array as Arr, Effect, Schema } from "effect"
import * as Authorization from "../src/Authorization.ts"
import * as Roles from "../src/Roles.ts"

const principal = {
	kind: "member",
	userId: "user_a",
	organizationId: "org_a",
} as const
const chat = Authorization.Chat.make({
	organizationId: "org_a",
	ownerUserId: "user_a",
	id: "chat_a",
})

it.effect(
	"role requests use policy text and keep the rule after a round trip",
	() =>
		Effect.gen(function* () {
			const policy = Policy.define(Authorization.OpenBot)(function* (_) {
				yield* _.allow("read", Authorization.Chat, {
					when: ($) => $.eq("ownerUserId", $.principal("userId")),
				})
				yield* _.deny("write", Authorization.Chat)
			})
			const text = yield* Schema.encodeEffect(Authorization.PolicySchema)(
				policy,
			)
			assert.isString(text)
			const loaded = yield* Schema.decodeEffect(Authorization.PolicyInput)(text)
			assert.strictEqual(
				Policy.decideSync(loaded, { principal, resource: chat, action: "read" })
					._tag,
				"Allow",
			)
			assert.strictEqual(
				Policy.decideSync(loaded, {
					principal,
					resource: chat,
					action: "write",
				})._tag,
				"Deny",
			)
			assert.strictEqual(
				Policy.decideSync(loaded, {
					principal: { ...principal, userId: "user_b" },
					resource: chat,
					action: "read",
				})._tag,
				"NotApplicable",
			)
			const body = yield* Schema.encodeEffect(Roles.CreateRoleRequest)({
				name: "Reader",
				description: "Reads Chats.",
				policy,
			})
			assert.strictEqual(body.policy, text)
			const object = yield* Schema.decodeEffect(
				Schema.fromJsonString(Schema.Json),
			)(text)
			assert.isFalse(
				yield* Effect.isSuccess(
					Schema.decodeUnknownEffect(Authorization.PolicyInput)(object),
				),
			)
		}),
)

it.effect("policy text rejects wrong fields and broken JSON", () =>
	Effect.gen(function* () {
		for (const text of [
			"{",
			'{"_tag":"Rules","algorithm":"denyOverrides","rules":[{"_tag":"Allow","actions":["read"],"resources":["Chat"],"fields":["owner*"]}]}',
			'{"_tag":"Rules","algorithm":"denyOverrides","rules":[{"_tag":"Allow","actions":["fly"],"resources":["Chat"]}]}',
		])
			assert.isFalse(
				yield* Effect.isSuccess(
					Schema.decodeEffect(Authorization.PolicyInput)(text),
				),
			)
	}),
)

it.effect("every built-in policy can be stored as text", () =>
	Effect.gen(function* () {
		for (const policy of [
			Authorization.emptyPolicy,
			Authorization.defaultTokenPolicy,
			...Arr.map(Authorization.builtinRoles, (role) => role.policy),
		]) {
			const text = yield* Schema.encodeEffect(Authorization.PolicySchema)(
				policy,
			)
			const loaded = yield* Schema.decodeEffect(Authorization.PolicySchema)(
				text,
			)
			assert.strictEqual(
				Policy.decideSync(loaded, { principal, resource: chat, action: "read" })
					._tag,
				Policy.decideSync(policy, { principal, resource: chat, action: "read" })
					._tag,
			)
		}
	}),
)

it.effect(
	"billing roles can add credits but cannot read chats or manage members",
	() =>
		Effect.sync(() => {
			const role = Arr.findFirst(
				Authorization.builtinRoles,
				(r) => r.id === "billing",
			)
			if (role._tag === "None")
				return assert.fail("The billing role is missing.")
			const wallet = Authorization.Wallet.make({ organizationId: "org_a" })
			assert.equal(
				Policy.decideSync(role.value.policy, {
					principal,
					resource: wallet,
					action: "write",
				})._tag,
				"Allow",
			)
			assert.notEqual(
				Policy.decideSync(role.value.policy, {
					principal,
					resource: Authorization.Wallet.make({ organizationId: "org_b" }),
					action: "write",
				})._tag,
				"Allow",
			)
			assert.notEqual(
				Policy.decideSync(role.value.policy, {
					principal,
					resource: chat,
					action: "read",
				})._tag,
				"Allow",
			)
			assert.notEqual(
				Policy.decideSync(role.value.policy, {
					principal,
					resource: Authorization.Member.make({ organizationId: "org_a" }),
					action: "write",
				})._tag,
				"Allow",
			)
		}),
)
