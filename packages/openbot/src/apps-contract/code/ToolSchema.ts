import { CodeRuns as CodeDomain } from "@openbot-build/domain"
import { Schema } from "effect"

/** The names of the Code Mode tools. */
export const names = {
	api: "openbot_code_api",
	run: "openbot_run_code",
} as const

export const ApiInput = Schema.Struct({
	query: Schema.optionalKey(
		Schema.String.annotate({
			description:
				"Words to look for in the names and descriptions of the bindings.",
		}),
	),
	connections: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({
			description:
				"The first part of binding names, such as `calendar`, to show only these connections.",
		}),
	),
})
export const ApiResult = Schema.Struct({ declarations: Schema.String })
export const RunInput = Schema.Struct({
	code: CodeDomain.Code.annotate({
		description:
			"The body of an async JavaScript function. Use `await apps.<connection>.<name>(args)` and `return` the value you need.",
	}),
	reason: Schema.String.annotate({
		description:
			"Why you run this program. A decider reads it when a call needs a decision.",
	}),
})
