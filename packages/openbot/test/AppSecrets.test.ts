import { Authorizer } from "@nmnmcc/ability"
import { assert, it } from "@effect/vitest"
import {
	AppCalls,
	BotId,
	ConnectionId,
	Execution,
	ExecutionIdentity,
	Vaults as Domain,
} from "@openbot-build/domain"
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Ref,
	Result,
	Schema,
	String as Str,
} from "effect"
import * as AppSecrets from "../src/vaults/AppSecrets.ts"
import { type Usable, Vaults } from "../src/vaults/Vaults.ts"

const secret = "private-value/42"
const identity: ExecutionIdentity = {
	owner: { organizationId: "org", userId: "owner" },
	actor: { kind: "member", organizationId: "org", userId: "actor" },
	botId: BotId.make("bot"),
}
const source: AppCalls.Source = {
	connectionId: ConnectionId.make("connection"),
	connectionName: "Notes",
	cardUrl: "https://app.example/card",
	appName: "Notes",
	remoteIndex: 0,
	revision: 1,
	kind: "tool",
	name: "write",
}
const usable: Usable = {
	vaultName: "Team",
	item: {
		id: Domain.VaultItemId.make("original"),
		vault: Domain.VaultId.make("vault"),
		name: "login",
		description: "",
		source: { _tag: "Builtin" },
		fields: ["token"],
		exits: [
			{
				_tag: "App",
				connection: ConnectionId.make("connection"),
				tool: "write",
			},
		],
		version: 0,
		createdAt: 0,
		updatedAt: 0,
	},
}
const bindings: ReadonlyArray<Domain.ReferenceBinding> = [
	{ alias: "login", item: usable.item.id, fields: ["token"] },
]
for (const mode of [
	"current",
	"grant gone",
	"item replaced",
	"field gone",
	"exit gone",
	"actor denied",
	"actor hidden",
	"changed during read",
	"grant gone during read",
	"actor denied during read",
] as const) {
	it.effect(`Vault values check ${mode} before sending`, () =>
		Effect.gen(function* () {
			const reads = yield* Ref.make(0)
			const members = yield* Ref.make(0)
			const items = yield* Ref.make<ReadonlyArray<Usable>>(
				mode === "grant gone"
					? []
					: [
							{
								...usable,
								item: {
									...usable.item,
									...(mode === "item replaced"
										? { id: Domain.VaultItemId.make("replacement") }
										: {}),
									...(mode === "field gone" ? { fields: [] } : {}),
									...(mode === "exit gone" ? { exits: [] } : {}),
								},
							},
						],
			)
			const actorAllowed = yield* Ref.make(
				mode !== "actor denied" && mode !== "actor hidden",
			)
			const service = Layer.mock(Vaults, {
				usable: (org, bot) =>
					Effect.gen(function* () {
						assert.equal(org, "org")
						assert.equal(bot, "bot")
						return yield* Ref.get(items)
					}),
				get: (actor, id, action) =>
					Effect.gen(function* () {
						assert.deepEqual(actor, identity.actor)
						assert.equal(id, "vault")
						assert.equal(action, "use")
						yield* Ref.update(members, (n) => n + 1)
						if (mode === "actor hidden")
							return yield* Domain.VaultNotFound.make({ id })
						if (!(yield* Ref.get(actorAllowed)))
							return yield* Authorizer.Forbidden.make({
								action: "use",
								kind: "Vault",
							})
						return {
							id: usable.item.vault,
							name: "Team",
							owner: { _tag: "Organization" as const },
							version: 0,
							createdAt: 0,
							updatedAt: 0,
						}
					}),
				reveal: (org, id, fields) =>
					Effect.gen(function* () {
						assert.equal(org, "org")
						assert.equal(id, "original")
						assert.deepEqual(fields, ["token"])
						yield* Ref.update(reads, (n) => n + 1)
						if (mode === "changed during read")
							yield* Ref.set(items, [
								{ ...usable, item: { ...usable.item, version: 1 } },
							])
						if (mode === "grant gone during read") yield* Ref.set(items, [])
						if (mode === "actor denied during read")
							yield* Ref.set(actorAllowed, false)
						return new Map([["token", secret]])
					}),
			})
			const run = Effect.gen(function* () {
				const adapter = yield* AppSecrets.make
				const ready = yield* adapter.prepare(
					identity,
					source,
					{ token: "Bearer ⟦vault:login/token⟧" },
					bindings,
				)
				assert.deepEqual(Redacted.value(ready.arguments), {
					token: "Bearer " + secret,
				})
				const output = yield* ready.result({
					_tag: "Completed",
					result: { [secret]: encodeURIComponent(secret) },
				})
				assert.deepEqual(output, {
					_tag: "Completed",
					result: { "⟦hidden:login/token⟧": "⟦hidden:login/token⟧" },
				})
				return ready.arguments
			}).pipe(Effect.provide(service), Effect.scoped, Effect.result)
			const result = yield* run
			if (mode === "current") {
				assert.ok(Result.isSuccess(result))
				assert.equal(Redacted.wipeUnsafe(Result.getOrThrow(result)), false)
				assert.equal(yield* Ref.get(members), 2)
			} else {
				assert.ok(Result.isFailure(result))
				assert.ok(
					Schema.is(Execution.Forbidden)(result.failure) ||
						Schema.is(Authorizer.Forbidden)(result.failure),
				)
			}
			assert.equal(
				yield* Ref.get(reads),
				mode === "current" ||
					mode === "changed during read" ||
					mode === "grant gone during read" ||
					mode === "actor denied during read"
					? 1
					: 0,
			)
		}),
	)
}
it.effect(
	"Vault aliases cannot gain fields or name another item on replay",
	() =>
		Effect.gen(function* () {
			const adapter = yield* AppSecrets.make
			for (const saved of [
				[],
				[{ ...bindings[0]!, fields: [] }],
				[bindings[0]!, bindings[0]!],
			]) {
				const result = yield* Effect.scoped(
					adapter.prepare(
						identity,
						source,
						{ token: "⟦vault:login/token⟧" },
						saved,
					),
				).pipe(Effect.result)
				assert.ok(Result.isFailure(result))
			}
		}).pipe(
			Effect.provide(
				Layer.mock(Vaults, { usable: () => Effect.succeed([usable]) }),
			),
		),
)
it.effect("plain App calls need no Vault reads", () =>
	Effect.gen(function* () {
		const adapter = yield* AppSecrets.make
		const ready = yield* adapter.prepare(
			identity,
			source,
			{ text: "hello" },
			[],
		)
		assert.deepEqual(Redacted.value(ready.arguments), { text: "hello" })
	}).pipe(Effect.provide(Layer.mock(Vaults, {})), Effect.scoped),
)

it.effect("a stopped Vault read closes its scope before an App can send", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const closed = yield* Ref.make(false)
		const sent = yield* Ref.make(false)
		const work = Effect.gen(function* () {
			const adapter = yield* AppSecrets.make
			yield* adapter.prepare(
				identity,
				source,
				{ token: "⟦vault:login/token⟧" },
				bindings,
			)
			yield* Ref.set(sent, true)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.mock(Vaults, {
					usable: () => Effect.succeed([usable]),
					get: () =>
						Effect.succeed({
							id: usable.item.vault,
							name: "Team",
							owner: { _tag: "Organization" },
							version: 0,
							createdAt: 0,
							updatedAt: 0,
						}),
					reveal: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(started, undefined)
							return yield* Effect.never
						}).pipe(Effect.ensuring(Ref.set(closed, true))),
				}),
			),
		)
		const fiber = yield* Effect.forkScoped(work)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(fiber)
		assert.equal(yield* Ref.get(closed), true)
		assert.equal(yield* Ref.get(sent), false)
	}).pipe(Effect.scoped),
)

for (const mode of ["unavailable", "resource", "input required"] as const) {
	it.effect(`Vault calls stop before an unsafe result: ${mode}`, () =>
		Effect.gen(function* () {
			const reads = yield* Ref.make(0)
			const adapter = yield* AppSecrets.make.pipe(
				Effect.provide(
					Layer.mock(Vaults, {
						usable: () =>
							mode === "unavailable"
								? Effect.fail(Domain.VaultsUnavailable.make({}))
								: Effect.succeed([usable]),
						get: () =>
							Effect.succeed({
								id: usable.item.vault,
								name: "Team",
								owner: { _tag: "Organization" },
								version: 0,
								createdAt: 0,
								updatedAt: 0,
							}),
						reveal: () =>
							Ref.update(reads, (n) => n + 1).pipe(
								Effect.as(new Map([["token", secret]])),
							),
					}),
				),
			)
			const prepare = adapter.prepare(
				identity,
				{ ...source, kind: mode === "resource" ? "resource" : "tool" },
				{ token: "Bearer ⟦vault:login/token⟧" },
				bindings,
			)
			if (mode !== "input required") {
				const failure = yield* prepare.pipe(Effect.flip)
				assert.equal(
					failure._tag,
					mode === "unavailable" ? "VaultsUnavailable" : "ExecutionForbidden",
				)
				assert.equal(yield* Ref.get(reads), 0)
				return
			}
			const ready = yield* prepare
			const failure = yield* ready
				.result({
					_tag: "InputRequired",
					result: {
						resultType: "input_required",
						requestState: secret,
						inputRequests: {},
					},
					respond: () => Effect.die("The response must stay blocked"),
					handle: Effect.die("The input handler must stay blocked"),
				})
				.pipe(Effect.flip)
			assert.equal(failure._tag, "ClientError")
			assert.isFalse(
				Str.includes(secret)(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
						failure,
					),
				),
			)
		}).pipe(Effect.scoped),
	)
}
