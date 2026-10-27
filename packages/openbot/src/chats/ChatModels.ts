import { Config, ConfigurationOperations } from "@openbot-build/core"
import {
	ChatModelInvalid,
	type ChatKind,
	type Bots,
} from "@openbot-build/domain"
import { Effect, Option } from "effect"
import type { Catalog } from "../models/ModelRegistry.ts"

/** Check the full selection, including reasoning effort and service tier. */
export const validate = (catalog: Catalog, selection: Config.Selection) => {
	const problem = ConfigurationOperations.selectionProblem(catalog, selection)
	return Option.isSome(problem)
		? Effect.fail(ChatModelInvalid.make(problem.value))
		: Effect.succeed(selection)
}

/** Creation uses one catalog snapshot. A failed catalog read must not select a fallback. */
export const select = (
	input: {
		readonly kind: ChatKind
		readonly bot: Pick<Bots.Bot, "model" | "source">
		readonly model?: Config.Selection
		readonly defaultModel?: Config.Selection
	},
	catalog: Catalog,
) =>
	Effect.gen(function* () {
		if (input.kind === "live") {
			if (input.model !== undefined)
				return yield* validate(catalog, input.model)
			const first = catalog.models[0]
			if (first === undefined)
				return yield* ChatModelInvalid.make({
					reason: "missing",
					message: "The organization has no Live model.",
				})
			return yield* validate(
				catalog,
				Config.Selection.make({ provider: first.provider, model: first.id }),
			)
		}
		// A linked Bot can name a model that its receiving organization does not have.
		const botModel =
			input.bot.model === undefined
				? undefined
				: input.bot.source === undefined
					? input.bot.model
					: Option.getOrUndefined(
							yield* validate(catalog, input.bot.model).pipe(Effect.option),
						)
		const selected = botModel ?? input.defaultModel
		if (selected === undefined)
			return yield* ChatModelInvalid.make({
				reason: "missing",
				message: "Set the model of the Bot.",
			})
		return yield* validate(catalog, selected)
	})
