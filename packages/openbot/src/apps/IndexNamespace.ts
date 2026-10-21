import { Context } from "effect"

/**
 * The namespace of the Public Index rows, such as index jobs and entries.
 * The development host uses its own namespace, so its checks never reach the public Index.
 */
export const IndexNamespace = Context.Reference<string>(
	"@openbot-build/openbot/apps/IndexNamespace",
	{ defaultValue: () => "public" },
)
