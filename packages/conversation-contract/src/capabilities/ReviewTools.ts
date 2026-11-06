import { Execution } from "@openbot-build/domain"
import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { CallContext } from "@openbot-build/server-execution/CallContext"
import type { Fence } from "@openbot-build/server-execution/Store"

export const names = {
	approve: "openbot_approve",
	deny: "openbot_deny",
	ask: "openbot_ask",
	escalate: "openbot_escalate",
	proposeRule: "openbot_propose_rule",
} as const

export interface Service {
	readonly register: (fence: Fence) => Effect.Effect<
		{
			tools: {
				readonly openbot_approve: Tool.Tool<
					"openbot_approve",
					{
						readonly parameters: Schema.Struct<{
							readonly scope: Schema.Literals<
								readonly ["once", "chat", "lifetime"]
							>
							readonly reason: Schema.optionalKey<Schema.String>
						}>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_ask: Tool.Tool<
					"openbot_ask",
					{
						readonly parameters: Schema.Struct<{
							readonly question: Schema.String
						}>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_deny: Tool.Tool<
					"openbot_deny",
					{
						readonly parameters: Schema.Struct<{
							readonly reason: Schema.String
							readonly scope: Schema.optionalKey<
								Schema.Literals<readonly ["once", "chat", "lifetime"]>
							>
						}>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_escalate: Tool.Tool<
					"openbot_escalate",
					{
						readonly parameters: Schema.Struct<{ readonly note: Schema.String }>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_propose_rule: Tool.Tool<
					"openbot_propose_rule",
					{
						readonly parameters: Schema.Struct<{ readonly text: Schema.String }>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
			}
			handlers: Context.Context<
				Tool.HandlersFor<{
					readonly openbot_approve: Tool.Tool<
						"openbot_approve",
						{
							readonly parameters: Schema.Struct<{
								readonly scope: Schema.Literals<
									readonly ["once", "chat", "lifetime"]
								>
								readonly reason: Schema.optionalKey<Schema.String>
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_ask: Tool.Tool<
						"openbot_ask",
						{
							readonly parameters: Schema.Struct<{
								readonly question: Schema.String
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_deny: Tool.Tool<
						"openbot_deny",
						{
							readonly parameters: Schema.Struct<{
								readonly reason: Schema.String
								readonly scope: Schema.optionalKey<
									Schema.Literals<readonly ["once", "chat", "lifetime"]>
								>
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_escalate: Tool.Tool<
						"openbot_escalate",
						{
							readonly parameters: Schema.Struct<{
								readonly note: Schema.String
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_propose_rule: Tool.Tool<
						"openbot_propose_rule",
						{
							readonly parameters: Schema.Struct<{
								readonly text: Schema.String
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
				}>
			>
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class ReviewTools extends Context.Service<ReviewTools, Service>()(
	"@openbot-build/conversation-contract/capabilities/ReviewTools",
) {}
