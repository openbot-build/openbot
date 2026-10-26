import { Chat, Config } from "@openbot-build/core"
import type { Identity } from "@openbot-build/api"
import {
	Cause,
	Context,
	Duration,
	Effect,
	Equal,
	Hash,
	Layer,
	RcMap,
	Scope,
} from "effect"
import * as ManagedChats from "../chats/ManagedChats.ts"
import * as Chats from "../chats/Chats.ts"
import { Backend } from "./Backend.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as ModelRegistry from "../models/ModelRegistry.ts"

export interface Options {
	/**
	 * The model of a new Chat when its Bot names none. Only a simulated
	 * platform has one, such as development or a test.
	 */
	readonly defaultModel?: Config.Selection
	/**
	 * How long a runtime stays open after its last use. A running Turn and a
	 * background tool call use it, so a runtime that works stays open. The
	 * default is 10 minutes.
	 */
	readonly idleTimeToLive?: Duration.Input
}

const noModels: Chats.Catalog = { providers: [], models: [] }

/**
 * The key of a runtime. Two keys with the same namespace are the same key:
 * the owner of the first key builds the runtime, and each use checks that
 * its owner is the same.
 */
class Key implements Equal.Equal {
	readonly namespace: string
	readonly owner: typeof Identity.Service
	constructor(namespace: string, owner: typeof Identity.Service) {
		this.namespace = namespace
		this.owner = owner
	}
	[Equal.symbol](that: Equal.Equal): boolean {
		return that instanceof Key && that.namespace === this.namespace
	}
	[Hash.symbol](): number {
		return Hash.string(this.namespace)
	}
}

interface Runtime {
	readonly owner: typeof Identity.Service
	readonly chats: Chats.Instance
}

/**
 * Each namespace owns one Chat runtime. A runtime is built the first time it
 * is used, and closes when nothing has used it for `idleTimeToLive`. Each call
 * of the Chats uses the runtime while it runs, and so do running Turns and
 * background tool calls. The build of one runtime does not wait for others.
 */
export const layer = (options: Options = {}) =>
	Layer.effect(
		Backend,
		Effect.gen(function* () {
			const registry = yield* ModelRegistry.ModelRegistry
			// The runtimes take the services and the context of this layer, so a
			// runtime never uses the services, log annotations, spans or request
			// of the call that happens to open it.
			const build = yield* ManagedChats.factory
			/** The catalog of a member, or no models when it cannot be read now. */
			const catalogOf = (
				read: Effect.Effect<Chats.Catalog, Config.ModelConfigurationError>,
			) =>
				read.pipe(
					Effect.catchTag("ModelConfigurationError", (error) =>
						Effect.logWarning(
							"OpenBot cannot read the models of an organization.",
							error,
						).pipe(Effect.as(noModels)),
					),
				)
			/** The models of a runtime: the models of the organization of its owner. */
			const modelsOf = (
				owner: typeof Identity.Service,
			): Pick<
				Chats.Options,
				"modelCatalog" | "liveCatalog" | "resolveModel"
			> => ({
				modelCatalog: catalogOf(registry.catalog(owner.organizationId)),
				liveCatalog: catalogOf(registry.liveCatalog(owner.organizationId)),
				resolveModel: (selection) =>
					registry.resolve(owner.organizationId, selection),
			})
			const context = yield* Effect.context<never>()
			const runtimes: RcMap.RcMap<Key, Runtime> = yield* RcMap.make({
				lookup: (key: Key) =>
					build({
						...modelsOf(key.owner),
						namespace: key.namespace,
						owner: key.owner,
						...(options.defaultModel === undefined
							? {}
							: { defaultModel: options.defaultModel }),
						// Work of the runtime uses it like a call does, so it stays open.
						keepOpen: Effect.asVoid(RcMap.get(runtimes, key)),
						// Input that comes after this runtime closed goes to the open one.
						current: chatsOf(key),
					}).pipe(
						Effect.map((chats) => ({ owner: key.owner, chats })),
						// A failed build is not kept, so the next use builds again.
						Effect.onError((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.void
								: RcMap.invalidate(runtimes, key),
						),
						// RcMap.get runs the lookup with the context of the caller over the
						// context of the map. A runtime lives longer than the call that opens
						// it, so it runs with the context of this layer and its own scope.
						// Then no log annotation, span, Identity or request of that call stays
						// in the runtime. This replaces the whole context: provideContext
						// would merge, and the keys of the call would stay.
						Effect.updateContext((lookup: Context.Context<Scope.Scope>) =>
							Context.add(
								context,
								Scope.Scope,
								Context.get(lookup, Scope.Scope),
							),
						),
					),
				idleTimeToLive: options.idleTimeToLive ?? Duration.minutes(10),
			})
			/** Uses the runtime of a key until the current scope closes. */
			const open = (key: Key) =>
				RcMap.get(runtimes, key).pipe(
					Effect.flatMap((runtime) =>
						ownerKey(runtime.owner) === ownerKey(key.owner)
							? Effect.succeed(runtime.chats)
							: Effect.fail(
									Chat.ChatError.make({
										reason: "unavailable",
										message: "This Chat runtime belongs to another account.",
									}),
								),
					),
				)
			/**
			 * The Chats of a key. Each call uses the runtime while it runs, so the
			 * runtime does not close under it. When it closed after a quiet time, the
			 * call builds it again.
			 */
			const chatsOf = (key: Key): typeof Chats.Chats.Service => {
				// `get` checked the owner of the namespace. Only a caller that breaks the
				// rule of one owner for each namespace can change it, so that is a defect.
				const current = open(key).pipe(Effect.orDie)
				const use = <A, E, R>(
					f: (chats: Chats.Instance) => Effect.Effect<A, E, R>,
				) => Effect.scoped(Effect.flatMap(current, f))
				return Chats.Chats.of({
					create: (input) => use((chats) => chats.create(input)),
					direct: (bot, chain) => use((chats) => chats.direct(bot, chain)),
					get: (id) => use((chats) => chats.get(id)),
					read: (id) => use((chats) => chats.read(id)),
					list: (input) => use((chats) => chats.list(input)),
					update: (id, input) => use((chats) => chats.update(id, input)),
					change: (id, update) => use((chats) => chats.change(id, update)),
					remove: (id) => use((chats) => chats.remove(id)),
					models: (id) => use((chats) => chats.models(id)),
					todos: (id) => use((chats) => chats.todos(id)),
					updateTodos: (id, input) =>
						use((chats) => chats.updateTodos(id, input)),
					wait: (id, after, timeout, afterActivity) =>
						use((chats) => chats.wait(id, after, timeout, afterActivity)),
					interrupt: (id) => use((chats) => chats.interrupt(id)),
					deliver: (id, input) => use((chats) => chats.deliver(id, input)),
					// The live events run as long as the scope of the caller, so the
					// runtime stays open for that time.
					deliverStream: (id, input) =>
						Effect.flatMap(current, (chats) => chats.deliverStream(id, input)),
					drain: (id) => use((chats) => chats.drain(id)),
					closeStale: (id, turn) => use((chats) => chats.closeStale(id, turn)),
					operations: {
						run: (input, work, status) =>
							use((chats) => chats.operations.run(input, work, status)),
						get: (chat, id) => use((chats) => chats.operations.get(chat, id)),
						list: (chat) => use((chats) => chats.operations.list(chat)),
						wait: (chat, ids, timeout) =>
							use((chats) => chats.operations.wait(chat, ids, timeout)),
						cancel: (chat, id) =>
							use((chats) => chats.operations.cancel(chat, id)),
						cancelChat: (chat) =>
							use((chats) => chats.operations.cancelChat(chat)),
					},
					startAction: (id, input) =>
						use((chats) => chats.startAction(id, input)),
					turns: (id, input) => use((chats) => chats.turns(id, input)),
					turn: (id, turn) => use((chats) => chats.turn(id, turn)),
					turnItems: (id, turn, input) =>
						use((chats) => chats.turnItems(id, turn, input)),
					turnLog: (id, turn) => use((chats) => chats.turnLog(id, turn)),
					itemsAfter: (id, after) =>
						use((chats) => chats.itemsAfter(id, after)),
					items: (id, input) => use((chats) => chats.items(id, input)),
				})
			}
			const get: (typeof Backend.Service)["get"] = (namespace, owner) => {
				const key = new Key(namespace, owner)
				// The first use builds the runtime, so a failed build fails here.
				return Effect.scoped(open(key)).pipe(Effect.as(chatsOf(key)))
			}
			return Backend.of({
				get,
				forCaller: (caller) =>
					get(ownerKey(caller), {
						kind: "member",
						userId: caller.userId,
						organizationId: caller.organizationId,
					}),
			})
		}),
	)
