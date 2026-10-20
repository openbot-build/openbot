import { Context, Effect, Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import { Config, Model, Provider } from "@openbot-build/core"

class Host extends Context.Service<Host, string>()(
	"@openbot-build/core/test/Model.types/Host",
) {}

type Assert<Condition extends true> = Condition

/** Type-only checks: making a model and the requirements of its model Layer stay separate. */
export const checkRuntimeModelTypes = (input: {
	readonly layer: Layer.Layer<LanguageModel.LanguageModel, never, Host>
	readonly provider: Provider.Provider<"host-failed", Host, Host>
	readonly selection: Config.Selection
}) => {
	const options = {
		provider: input.selection.provider,
		model: input.selection.model,
	}
	const model = Model.make({ ...options, layer: input.layer })
	// @ts-expect-error A Layer that does not provide LanguageModel cannot be a runtime Model.
	const empty = Model.make({ ...options, layer: Layer.empty })
	const wrongId = Model.make({
		...options,
		// @ts-expect-error A provider ID cannot identify the selected model.
		model: options.provider,
		layer: input.layer,
	})
	const created = input.provider.model(input.selection)
	const captured: Effect.Effect<
		Layer.Layer<LanguageModel.LanguageModel>,
		never,
		Host
	> = model.captureRequirements
	const channels: [
		Assert<"host-failed" extends Effect.Error<typeof created> ? true : false>,
		Assert<Host extends Effect.Services<typeof created> ? true : false>,
		Assert<
			Host extends Layer.Services<Effect.Success<typeof created>> ? true : false
		>,
		Assert<Host extends Layer.Services<typeof model> ? true : false>,
	] = [true, true, true, true]
	return {
		model,
		empty,
		wrongId,
		created,
		captured,
		channels,
	}
}
