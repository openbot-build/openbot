import { Effect, Layer } from "effect"
import * as ChatGptOAuth from "../model-providers/providers/chatgpt/OAuth.ts"
import * as ModelProvidersPostgres from "./ModelProvidersPostgres.ts"
import * as ModelRegistry from "./ModelRegistry.ts"
import * as ModelsPostgres from "./ModelsPostgres.ts"
import * as ProviderOAuth from "./ProviderOAuth.ts"
import { BuiltinModels } from "./Wiring.ts"

/**
 * The models: the stored providers and models, and the model registry. The
 * registry meters each model call, so it needs the spending services. It
 * reads the built-in models from the `BuiltinModels` reference. The static
 * assembly and the models plugin both use it.
 */
export const layerModels = Layer.unwrap(
	Effect.map(BuiltinModels, (builtin) =>
		ModelRegistry.layer(builtin === undefined ? {} : { builtin }),
	),
).pipe(
	Layer.provideMerge(
		ProviderOAuth.layer.pipe(Layer.provide(ChatGptOAuth.layer)),
	),
	Layer.provideMerge(
		Layer.merge(ModelProvidersPostgres.layer, ModelsPostgres.layer),
	),
)
