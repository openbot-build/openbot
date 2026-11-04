import { Context } from "effect"
import type * as ModelRegistry from "./ModelRegistry.ts"

/**
 * Models that the program gives itself, such as the simulated models of
 * development or of a test. With no value, there are none. The host sets it.
 */
export const BuiltinModels = Context.Reference<
	ModelRegistry.Builtin | undefined
>("@openbot-build/openbot/plugin-models/Wiring/BuiltinModels", {
	defaultValue: () => undefined,
})
