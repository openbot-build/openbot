import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { BotsApi } from "@openbot-build/api"
import { Chat } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Semaphore,
	pipe,
} from "effect"
import { BotRecords, type Keys } from "../src/bots/BotRecords.ts"
import { Grants, make } from "../src/capabilities/Grants.ts"
import { decidingGrant } from "../src/capabilities/Policy.ts"

const bot = BotsApi.BotId.make("bot_1")
const here = Chat.Id.make("chat_here")
const there = Chat.Id.make("chat_there")

/**
 * Bot records in memory. A transaction takes one lock for all keys, as the lock of a key
 * does in Postgres. Other fibers go first after a read, so two calls can meet in the middle.
 */
const memoryRecords = Layer.effect(
	BotRecords,
	Effect.gen(function* () {
		const rows = yield* Ref.make(
			HashMap.empty<string, { readonly keys: Keys; readonly value: unknown }>(),
		)
		const lock = yield* Semaphore.make(1)
		return {
			collection: (kind: string) => ({
				find: (organizationId: string, id: string) =>
					Ref.get(rows).pipe(
						Effect.tap(() => Effect.yieldNow),
						Effect.map((all) =>
							Option.map(
								HashMap.get(all, kind + ":" + organizationId + ":" + id),
								(row) => row.value,
							),
						),
					),
				list: (
					organizationId: string,
					filter: Partial<Pick<Keys, "owner" | "scope" | "status">> = {},
				) =>
					Effect.map(Ref.get(rows), (all) =>
						pipe(
							Arr.fromIterable(HashMap.values(all)),
							Arr.filter(
								(row) =>
									row.keys.organizationId === organizationId &&
									(filter.owner === undefined ||
										row.keys.owner === filter.owner) &&
									(filter.scope === undefined ||
										row.keys.scope === filter.scope) &&
									(filter.status === undefined ||
										row.keys.status === filter.status),
							),
							Arr.map((row) => row.value),
						),
					),
				put: (keys: Keys, value: unknown) =>
					Ref.update(
						rows,
						HashMap.set(kind + ":" + keys.organizationId + ":" + keys.id, {
							keys,
							value,
						}),
					),
			}),
			transaction: <A, E, R>(_key: string, operation: Effect.Effect<A, E, R>) =>
				lock.withPermit(operation),
		} as unknown as BotRecords["Service"]
	}),
)

const grantsLayer = Layer.effect(Grants, make).pipe(
	Layer.provide([memoryRecords, NodeCrypto.layer]),
)

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
	Effect.map(decidingGrant({ grants, bot, capability, chat }), (found) =>
		Option.map(found, (grant) => grant.id),
	)

describe("The Grants of a Bot", () => {
	it.effect("let a deny Grant win, in any order", () =>
		Effect.gen(function* () {
			const allow = grant("grt_allow", { effect: "allow" })
			const deny = grant("grt_deny", { effect: "deny" })
			assert.deepStrictEqual(
				yield* decide([allow, deny]),
				Option.some("grt_deny"),
			)
			assert.deepStrictEqual(
				yield* decide([deny, allow]),
				Option.some("grt_deny"),
			)
		}),
	)

	it.effect("give the first allow Grant that covers the request", () =>
		Effect.gen(function* () {
			const other = grant("grt_other", { effect: "allow", target: "mail" })
			const any = grant("grt_any", { effect: "allow", target: "*" })
			assert.deepStrictEqual(
				yield* decide([other, any]),
				Option.some("grt_any"),
			)
			assert.deepStrictEqual(yield* decide([other]), Option.none())
			assert.deepStrictEqual(
				yield* decide([any], { action: "apps.call", target: "search" }),
				Option.none(),
			)
		}),
	)

	it.effect("match arguments exactly, and no arguments match any", () =>
		Effect.gen(function* () {
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
				yield* decide([exact], asking("rome")),
				Option.some("grt_exact"),
			)
			assert.deepStrictEqual(
				yield* decide([exact], asking("paris")),
				Option.none(),
			)
			assert.deepStrictEqual(
				yield* decide([free], asking("paris")),
				Option.some("grt_free"),
			)
		}),
	)

	it.effect("count a Chat Grant only in its own Chat", () =>
		Effect.gen(function* () {
			const chat = grant("grt_chat", {
				effect: "allow",
				scope: "chat",
				chat: here,
			})
			assert.deepStrictEqual(yield* decide([chat]), Option.some("grt_chat"))
			assert.deepStrictEqual(
				yield* decide([chat], undefined, there),
				Option.none(),
			)
		}),
	)

	it.effect("let only one of two calls at the same time use a once Grant", () =>
		Effect.gen(function* () {
			const grants = yield* Grants
			const once = yield* grants.create("org_1", {
				bot,
				capability: { action: "tools.call", target: "search" },
				effect: "allow",
				scope: "once",
				grantedBy: { _tag: "Person", userId: "user_1" },
			})
			const used = yield* Effect.all(
				[grants.use("org_1", once), grants.use("org_1", once)],
				{ concurrency: "unbounded" },
			)
			assert.strictEqual(Arr.filter(used, (taken) => taken).length, 1)
			// The Grant is used now, so a later call does not get it either.
			assert.strictEqual(yield* grants.use("org_1", once), false)
			assert.deepStrictEqual(
				Arr.map(yield* grants.list("org_1", bot, "used"), (grant) => grant.id),
				[once.id],
			)
		}).pipe(Effect.provide(grantsLayer)),
	)
})
