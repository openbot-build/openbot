import { Context } from "effect"
import type * as AppIndex from "./AppIndex.ts"
import type * as IndexWork from "./IndexWork.ts"

/**
 * The sources of the App Index. With no value, the Index uses its own
 * sources. The host sets it; a test gives its own sources.
 */
export const IndexSources = Context.Reference<
	ReadonlyArray<AppIndex.SourceProvider> | undefined
>("@openbot-build/openbot/plugin-apps/Wiring/IndexSources", {
	defaultValue: () => undefined,
})

/** How the work of the App Index runs. The host sets it. */
export const IndexWorkOptions = Context.Reference<IndexWork.Options>(
	"@openbot-build/openbot/plugin-apps/Wiring/IndexWorkOptions",
	{ defaultValue: () => ({}) },
)
