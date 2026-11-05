import type { Bot, Chat, ChatStore } from "@openbot-build/core"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import type { Tool } from "effect/ai"
import type { FeatureStopped } from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as Registration from "@openbot-build/tools-contract/plugins/Registration"

/** The tools of a part. A hook of a feature can stop the Turn. */
type Built = Bot.ToolRegistration<{}, FeatureStopped>

/** One part of the tools of a Turn: a feature, or a part that the Chats own. */
export interface Part<R = never> {
	readonly order: number
	/** A part that the Chats own comes before a feature with the same order. */
	readonly builtIn: boolean
	readonly id: string
	readonly build: "normal" | "last"
	readonly register: (
		occupied: ReadonlyArray<string>,
	) => Effect.Effect<Built, Chat.ChatNotFound | ChatStore.ChatStoreError, R>
}

/** The order number, then the parts that the Chats own, then the id. */
export const partOrder: Order.Order<Part<unknown>> = Order.combine(
	Order.combine(
		Order.mapInput(Order.Number, (part: Part<unknown>) => part.order),
		Order.mapInput(Order.Boolean, (part: Part<unknown>) => !part.builtIn),
	),
	Order.mapInput(Order.String, (part: Part<unknown>) => part.id),
)

const names = (registration: Built) => {
	const tools: Readonly<Record<string, Tool.Any>> = registration.tools
	return Rec.keys(tools)
}

/**
 * Builds the normal parts in order, then each "last" part in order. A "last"
 * part gets the names of the host, of the normal parts, of the "last" parts
 * before it, and then the reserved names. The tools merge after the host in
 * part order.
 */
export const assemble = <R>(
	host: Bot.ToolRegistration,
	parts: ReadonlyArray<Part<R>>,
	reserved: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		const sorted = Arr.sort(parts, partOrder)
		const normal = yield* Effect.forEach(
			Arr.filter(sorted, (part) => part.build === "normal"),
			(part) =>
				Effect.map(part.register([]), (registration) => ({
					part,
					registration,
				})),
		)
		const fixed = Registration.merge([
			host,
			...Arr.map(normal, (built) => built.registration),
		])
		const last = yield* Effect.reduce(
			Arr.filter(sorted, (part) => part.build === "last"),
			() => ({
				occupied: [...names(fixed), ...reserved],
				built: Arr.empty<{
					readonly part: Part<R>
					readonly registration: Built
				}>(),
			}),
			(state, part) =>
				Effect.map(part.register(state.occupied), (registration) => ({
					occupied: [...state.occupied, ...names(registration)],
					built: Arr.append(state.built, { part, registration }),
				})),
		)
		const built = [...normal, ...last.built]
		return Registration.merge([
			host,
			...Arr.getSomes(
				Arr.map(sorted, (part) =>
					Option.map(
						Arr.findFirst(built, (entry) => entry.part === part),
						(entry) => entry.registration,
					),
				),
			),
		])
	})
