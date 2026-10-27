import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import * as Engine from "../src/execution/Engine.ts"
import { WorkflowEngine } from "effect/workflow"
import { assert, it } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Chat, Turn } from "@openbot-build/core"
import {
	Authorization,
	Execution,
	ServiceId,
	TokenId,
	restrictExecution,
	type Caller,
} from "@openbot-build/domain"
import { Effect, Layer, Ref, Option, Schema } from "effect"
import { Bots } from "../src/bots/Bots.ts"
import * as CapabilityAccess from "../src/capabilities/CapabilityAccess.ts"
import { Grants } from "../src/capabilities/Grants.ts"
import { Judge } from "../src/capabilities/Judge.ts"
import { Rules } from "../src/capabilities/Rules.ts"
import { Work } from "../src/capabilities/Work.ts"
import { bot } from "./BotFixture.ts"

const member: Caller = {
	kind: "member",
	organizationId: "org",
	userId: "member",
}
const token: Caller = {
	...member,
	kind: "user_token",
	tokenId: TokenId.make("limited"),
}
const policy = Authorizer.layer(Authorization.Auth, {
	policy: (caller) =>
		Effect.succeed(
			Policy.define(Authorization.OpenBot)(function* (_) {
				yield* _.allow("*", "*")
				if (caller.kind === "user_token")
					yield* _.deny("use", Authorization.App)
			}),
		),
})
const access = CapabilityAccess.layer.pipe(
	Layer.provide(ErrorRecordsFixture.layer),
	Layer.provide([
		policy,
		Layer.mock(Bots, {}),
		Layer.mock(Grants, {}),
		Layer.mock(Rules, {}),
		Layer.mock(Judge, {}),
	]),
)

for (const source of [member, token]) {
	it.effect(
		`an App call keeps the token limit after ${source.kind} input`,
		() =>
			Effect.gen(function* () {
				const identity = restrictExecution(
					{
						owner: {
							organizationId: member.organizationId,
							userId: member.userId,
						},
						actor: source,
						botId: bot.id,
					},
					[source.kind === "member" ? token : member],
				)
				// A later member input and a child Bot keep the same token ceiling.
				const child = {
					...restrictExecution(identity, [member]),
					botId: bot.id,
				}
				const work = Work.of({
					identity: child,
					namespace: "org:member",
					bot,
					chain: {
						organizationId: "org",
						userId: "member",
						bots: [bot.id],
						chats: [],
					},
					deciders: [],
					chat: Chat.Id.make("chat"),
					turn: Turn.Id.make("turn"),
				})
				const gate = yield* CapabilityAccess.CapabilityAccess
				const attempt = {
					capability: { action: "apps.call" as const, target: "send" },
					reason: "Send the result",
					site: { main: "call", path: [] },
					implicit: true,
				}
				// Even implicit access must stop before Grants, Rules, or a new approval.
				assert.equal((yield* gate.check(work, attempt))._tag, "Deny")
			}).pipe(Effect.provide(access)),
	)
}

for (const action of [
	"apps.call",
	"plans.run",
	"delegations.continue",
	"tools.call",
	"computers.create",
	"computers.acquire",
	"computers.expose",
	"computers.delete",
] as const) {
	it.effect(
		`a Channel ${action} check uses current rights on its resource`,
		() =>
			Effect.gen(function* () {
				const revoked = yield* Ref.make(false)
				const currentPolicy = Authorizer.layer(Authorization.Auth, {
					policy: (caller) =>
						Ref.get(revoked).pipe(
							Effect.map((denied) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									yield* _.allow("*", "*")
									// The speaker can use the Channel but cannot run the owner's stored Chat.
									if (caller.userId === member.userId)
										yield* _.deny("run", Authorization.Chat, {
											when: ($) => $.eq("ownerUserId", "owner"),
										})
									if (denied && caller.kind === "user_token")
										yield* _.deny("use", Authorization.Channel, {
											when: ($) => $.eq("id", "channel"),
										})
									if (denied)
										for (const resource of [
											Authorization.App,
											Authorization.Chat,
											Authorization.Computer,
											Authorization.ComputerProvider,
										])
											yield* _.deny("*", resource, {
												when: ($) => $.eq("ownerUserId", "owner"),
											})
								}),
							),
						),
				})
				const gate = yield* CapabilityAccess.CapabilityAccess.pipe(
					Effect.provide(
						CapabilityAccess.layer.pipe(
							Layer.provide(ErrorRecordsFixture.layer),
							Layer.provide([
								currentPolicy,
								Layer.mock(Bots, {}),
								Layer.mock(Grants, {}),
								Layer.mock(Rules, {}),
								Layer.mock(Judge, {}),
							]),
						),
					),
				)
				const work = Work.of({
					identity: {
						owner: { organizationId: "org", userId: "owner" },
						actor: member,
						constraints: [{ ...token, userId: "owner" }],
						channel: { id: "channel", externalUserId: "speaker" },
					},
					namespace: "org:owner",
					bot,
					chain: {
						organizationId: "org",
						userId: "member",
						owner: "owner",
						bots: [bot.id],
						chats: [],
					},
					deciders: [],
					chat: Chat.Id.make("chat"),
					turn: Turn.Id.make("turn"),
				})
				const attempt = {
					capability: { action, target: "target" },
					reason: "Run the work",
					site: { main: "call", path: [] },
					implicit: true,
				}
				assert.equal((yield* gate.check(work, attempt))._tag, "Allow")
				yield* Ref.set(revoked, true)
				assert.equal((yield* gate.check(work, attempt))._tag, "Deny")
			}),
	)
}

it.effect(
	"a service cannot use member work and a member cannot use service work",
	() =>
		Effect.gen(function* () {
			const registry = yield* Engine.Registry
			const service = ServiceId.make("index")
			const key = { namespace: "test", id: Execution.Id.make("work") }
			const memberWork = Engine.define("member-test")
			const serviceWork = Engine.define("service-test")
			const allowed = yield* Ref.make(true)
			yield* registry.register(memberWork, () => Effect.void)
			yield* registry.registerService(serviceWork, service, () =>
				Ref.get(allowed).pipe(
					Effect.flatMap((value) =>
						value ? Effect.void : Effect.fail(Execution.Forbidden.make({})),
					),
				),
			)
			const first = Option.getOrThrow(yield* registry.get(memberWork._tag))
			const second = Option.getOrThrow(yield* registry.get(serviceWork._tag))
			const actor = { kind: "service" as const, serviceId: service }
			yield* first.authorize(key, member, "advance")
			yield* second.authorize(key, actor, "advance")
			for (const work of [
				first.authorize(key, actor, "advance"),
				second.authorize(key, member, "advance"),
				second.authorize(key, token, "read"),
				second.authorize(
					key,
					{ kind: "service", serviceId: ServiceId.make("files") },
					"advance",
				),
			])
				assert.ok(Schema.is(Execution.Forbidden)(yield* Effect.flip(work)))
			yield* Ref.set(allowed, false)
			assert.ok(
				Schema.is(Execution.Forbidden)(
					yield* second.authorize(key, actor, "replay").pipe(Effect.flip),
				),
			)
		}).pipe(
			Effect.provide(
				Engine.layerRegistry.pipe(Layer.provide(WorkflowEngine.layerMemory)),
			),
		),
)
