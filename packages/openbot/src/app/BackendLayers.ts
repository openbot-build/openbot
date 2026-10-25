import { Chat, ChatStore } from "@openbot-build/core"
import {
	Context,
	Option,
	HashMap,
	Effect,
	Exit,
	Layer,
	Scope,
	SynchronizedRef,
} from "effect"
import * as ManagedChats from "../chats/ManagedChats.ts"

import { type LanguageModel, type Tool, type Toolkit } from "effect/ai"
import * as Chats from "../chats/Chats.ts"
import type { PgClient } from "@effect/sql-pg"
import { Backend } from "./Backend.ts"
import type { Identity } from "@openbot-build/api"
import { ownerKey } from "../apps/StoredConnections.ts"

/** Each namespace owns one runtime graph. All graphs and fibers belong to the application. */
export const layer = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	options: Omit<Chats.Options<Tools, E, R, BuildE, BuildR>, "namespace"> = {},
) =>
	Layer.effect(
		Backend,
		Effect.gen(function* () {
			const scope = yield* Scope.Scope
			const context = yield* Effect.context<
				| PgClient.PgClient
				| R
				| BuildR
				| Tool.HandlersFor<Tools>
				| LanguageModel.ExtractServices<{
						readonly toolkit: Toolkit.WithHandler<Tools>
				  }>
			>()
			const instances = yield* SynchronizedRef.make(
				HashMap.empty<
					string,
					{
						readonly owner: typeof Identity.Service | undefined
						readonly chats: typeof Chats.Chats.Service
					}
				>(),
			)
			const get: (typeof Backend.Service)["get"] = (namespace, owner) =>
				SynchronizedRef.modifyEffect(instances, (map) =>
					Option.match(HashMap.get(map, namespace), {
						onSome: (existing) =>
							owner !== undefined &&
							(existing.owner === undefined ||
								ownerKey(owner) !== ownerKey(existing.owner))
								? Effect.fail(
										Chat.ChatError.make({
											reason: "unavailable",
											message: "This Chat runtime belongs to another account.",
										}),
									)
								: Effect.succeed([existing.chats, map] as const),
						onNone: () =>
							Effect.gen(function* () {
								const runtimeScope = yield* Scope.fork(scope)
								const organization =
									owner === undefined || options.organization === undefined
										? {}
										: options.organization(owner.organizationId)
								const instance = yield* ManagedChats.make({
									...options,
									...organization,
									namespace,
									...(owner === undefined ? {} : { owner }),
								}).pipe(
									Effect.mapError((error) =>
										error instanceof Chat.ChatError ||
										error instanceof ChatStore.ChatStoreError
											? error
											: Chat.ChatError.make({
													reason: "unavailable",
													message: String(error),
												}),
									),
									Effect.provideContext(
										Context.add(context, Scope.Scope, runtimeScope),
									),
									Effect.onExit((exit) =>
										Exit.isFailure(exit)
											? Scope.close(runtimeScope, exit)
											: Effect.void,
									),
								)
								return [
									instance,
									HashMap.set(map, namespace, { owner, chats: instance }),
								] as const
							}),
					}),
				)
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
