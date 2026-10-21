import { AppExecution } from "@openbot-build/api"
import { Effect, Match, Schema } from "effect"

export const json = (value: unknown) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(JSON.stringify(value))

export const failed = ({
	source,
	error,
}: {
	readonly source: AppExecution.Source
	readonly error: { readonly _tag: string }
}) =>
	Match.value(error).pipe(
		Match.when({ _tag: "OutcomeUnknown" }, () =>
			Effect.gen(function* () {
				const value = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ cause: Schema.optionalKey(Schema.String) }),
				)(error)
				return {
					_tag: "Failed",
					source,
					reason: "OutcomeUnknown",
					...value,
					message:
						"This operation may have reached the App. Check its actual state before taking another action.",
				} as const
			}),
		),
		Match.when({ _tag: "ToolFailure" }, () =>
			Effect.gen(function* () {
				const business = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ result: Schema.Unknown }),
				)(error)
				return {
					_tag: "Failed",
					source,
					reason: "ToolFailure",
					message: "The App reported a business failure.",
					result: yield* json(business.result),
				} as const
			}),
		),
		Match.when({ _tag: "ClientError" }, () =>
			Effect.gen(function* () {
				const failure = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ reason: Schema.String }),
				)(error)
				return {
					_tag: "Failed",
					source,
					reason: failure.reason,
					message:
						"The App operation did not return a valid result. Review the connection before continuing.",
				} as const
			}),
		),
		Match.orElse(() =>
			Effect.succeed({
				_tag: "Failed",
				source,
				reason: error._tag,
				message:
					"The App operation did not complete. Review the connection and recorded result before continuing.",
			} as const),
		),
	)
