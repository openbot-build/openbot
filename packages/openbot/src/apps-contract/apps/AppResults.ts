import { ChatConflict, AppCalls } from "@openbot-build/domain"

import { Client } from "@openbot-build/protocol"
import { Effect, Match, Schema } from "effect"

const jsonText = Schema.encodeUnknownEffect(
	Schema.fromJsonString(Schema.Unknown),
)

export const json = (value: unknown) =>
	jsonText(value).pipe(
		Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))),
	)

export const jsonObject = (value: unknown) =>
	jsonText(value).pipe(
		Effect.flatMap(
			Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject)),
		),
	)

/** Turns what an App operation returned into the result that OpenBot records. */
export const fromOperation =
	(source: AppCalls.Source) =>
	(
		operation: Client.OperationResult<unknown>,
	): Effect.Effect<AppCalls.Result, Schema.SchemaError> =>
		Match.value(operation).pipe(
			Match.tag("Completed", ({ result }) =>
				json(result).pipe(
					Effect.map(
						(result) => ({ _tag: "Completed", source, result }) as const,
					),
				),
			),
			Match.tag("InputRequired", ({ result }) =>
				json(result).pipe(
					Effect.map(
						(request) => ({ _tag: "InputRequired", source, request }) as const,
					),
				),
			),
			Match.exhaustive,
		)

export const failed = ({
	source,
	error,
}: {
	readonly source: AppCalls.Source
	readonly error: { readonly _tag: string }
}) =>
	Match.value(error).pipe(
		Match.when(Schema.is(Client.OutcomeUnknown), ({ cause }) =>
			Effect.succeed({
				_tag: "Failed",
				source,
				reason: "OutcomeUnknown",
				cause,
				message: outcomeUnknownMessage,
			} as const),
		),
		Match.when(Schema.is(Client.ToolFailure), ({ result }) =>
			json(result).pipe(
				Effect.map(
					(result) =>
						({
							_tag: "Failed",
							source,
							reason: "ToolFailure",
							message: "The App reported a business failure.",
							result,
						}) as const,
				),
			),
		),
		// The call may have stopped before it reached the App, for example when the
		// arguments do not match. The issue says why, so the model can fix the call.
		Match.when(Schema.is(Client.ClientError), ({ reason, issue }) =>
			Effect.succeed({
				_tag: "Failed",
				source,
				reason,
				message: `The App operation failed. Look at the call and the connection before you go on. The issue: ${issue}`,
			} as const),
		),
		// The conflict text is public and says why the App call did not run.
		Match.when(Schema.is(ChatConflict), ({ message }) =>
			Effect.succeed({
				_tag: "Failed",
				source,
				reason: "ChatConflict",
				message,
			} as const),
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

export const outcomeUnknownMessage =
	"This operation may have reached the App. Check its actual state before taking another action."
