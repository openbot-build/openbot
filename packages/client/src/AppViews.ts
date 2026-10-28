import {
	type StandardSchemaV1,
	specTypeSchemas,
} from "@modelcontextprotocol/client"
import { AppViewsApi as Api } from "@openbot-build/api"
import { Client as ProtocolClient } from "@openbot-build/protocol"
import type { UiClient } from "@openbot-build/protocol/McpApps"
import { decodeStandard } from "@openbot-build/protocol/McpClient"
import {
	Cause,
	Crypto,
	Effect,
	Option,
	Schema,
	Stream,
	type PlatformError,
} from "effect"
import { Client, type ClientError } from "./Client.ts"
import { AppViews, AppCalls, Execution } from "@openbot-build/domain"
import { prepare, type Command } from "./Command.ts"
import { observeTree, type ObservationError } from "./Executions.ts"

/** The failure of a view request when nothing more is known. */
const failed = () =>
	ProtocolClient.ClientError.make({
		reason: "Protocol",
		issue:
			"The App view request failed. Check its saved operation before you continue.",
	})
const decode = <A>(schema: StandardSchemaV1<unknown, A>, input: unknown) =>
	decodeStandard(() => schema, input, failed)
/** The `ClientError` reason for each reason of `AppViewUnavailable`. */
const reasons = {
	Declaration: "Protocol",
	Resource: "Protocol",
	ConnectionChanged: "ConnectionChanged",
	Closed: "Closed",
	Unsupported: "UnsupportedCapability",
	Protocol: "Protocol",
} as const satisfies Record<
	Api.AppViewUnavailable["reason"],
	ProtocolClient.ClientError["reason"]
>
/**
 * Gives a failed view request the error of an MCP client. A failure that the
 * server names keeps its meaning, and the text that the server writes for
 * clients. Any other failure, such as a lost network, becomes a protocol error.
 * The protocol error has no place for the old failure, so it is logged first.
 */
const rejected = (action: string, target: string) => {
	const denied = () =>
		Effect.fail(ProtocolClient.PermissionDenied.make({ action, target }))
	return <A>(request: Effect.Effect<A, ClientError | ObservationError>) =>
		Effect.catchTags(
			request,
			{
				AppViewUnavailable: (error) =>
					Effect.fail(
						ProtocolClient.ClientError.make({
							reason: reasons[error.reason],
							issue: error.message,
						}),
					),
				ChatConflict: (error) =>
					Effect.fail(
						ProtocolClient.ClientError.make({
							reason: "ConnectionChanged",
							issue: error.message,
						}),
					),
				// OpenBot also answers "not found" for a view that is closed.
				ExperienceNotFound: () =>
					Effect.fail(
						ProtocolClient.ClientError.make({
							reason: "Closed",
							issue: "OpenBot did not find the App view or its action.",
						}),
					),
				ExperienceInputInvalid: (error) =>
					Effect.fail(
						ProtocolClient.ClientError.make({
							reason: "Schema",
							issue: error.message,
						}),
					),
				AppRestricted: denied,
				Forbidden: denied,
				ExecutionForbidden: denied,
				MembershipRequired: denied,
				ForbiddenOrigin: denied,
			},
			(error) =>
				Effect.logWarning(
					"The App view request failed",
					Cause.fail(error),
				).pipe(Effect.andThen(Effect.fail(failed()))),
		)
}
export const toolResult = (value: unknown) =>
	decode(specTypeSchemas.CallToolResult, value)
/** A bridge tied to one saved view. Closing it only stops observation. */
export const make = Effect.fn("AppViews.make")(function* (
	opened: Api.Opened,
	owner: string,
	onChange: () => void = () => {},
) {
	const { api } = yield* Client
	const crypto = yield* Crypto.Crypto
	/** A new ID for each action, made when the action runs. */
	const newCommandKey = crypto
		.randomUUIDv7()
		.pipe(Effect.map(Execution.CommandKey.make), Effect.orDie)
	const params = { viewId: opened.id }
	const key = { owner, connectionId: opened.source.connectionId }
	const read = Effect.fn("AppViews.read")(function* (
		method: Api.ViewReadAction,
		cursor?: string,
	) {
		return yield* api.appViews
			.read({
				params,
				payload: { method, params: cursor === undefined ? {} : { cursor } },
			})
			.pipe(rejected(method, opened.id))
	})
	/** Follow saved child links. Approval can outlive the Turn that started it. */
	const invoke = Effect.fn("AppViews.invoke")(function* (
		payload: Api.ActionRequest,
	) {
		const { action, target } =
			payload.kind === "tool"
				? { action: "tools/call", target: payload.name }
				: { action: "resources/read", target: payload.uri }
		yield* Effect.annotateCurrentSpan({ action, target })
		const answer = rejected(action, target)
		const receipt = yield* api.appViews.act({ params, payload }).pipe(answer)
		const observed = yield* observeTree(receipt.executionId, {
			stopAt: ["AppCall"],
		}).pipe(
			Stream.provideService(Client, { api }),
			Stream.tap((event) =>
				event.body._tag === "State" || event.body._tag === "DecisionNeeded"
					? Effect.sync(onChange)
					: Effect.void,
			),
			Stream.mapEffect((event) =>
				Effect.gen(function* () {
					if (
						event.body._tag !== "Result" &&
						!(
							event.body._tag === "State" &&
							event.body.status === "outcome_unknown"
						)
					)
						return Option.none<AppCalls.ExecutionView>()
					const execution = yield* api.executions.get({
						params: { executionId: event.executionId },
					})
					if (execution.resource.kind !== "AppCall")
						return Option.none<AppCalls.ExecutionView>()
					return yield* api.appOperations
						.get({
							params: {
								id: AppCalls.AppOperationId.make(execution.resource.id),
							},
						})
						.pipe(
							Effect.asSome,
							Effect.map(
								Option.filter(
									(saved) =>
										Execution.isTerminal(saved.status) ||
										saved.status === "outcome_unknown",
								),
							),
						)
				}),
			),
			Stream.filter(Option.isSome),
			Stream.map((value) => value.value),
			Stream.runHead,
			answer,
		)
		if (Option.isNone(observed)) return yield* failed()
		const saved = observed.value
		if (saved.status === "outcome_unknown")
			return yield* ProtocolClient.OutcomeUnknown.make({
				key,
				target,
				cause: "Network",
			})
		if (saved.status === "completed" && saved.result?._tag === "Completed")
			return saved.result.result
		if (saved.failure?.category === "forbidden")
			return yield* ProtocolClient.PermissionDenied.make({ action, target })
		return yield* ProtocolClient.ClientError.make({
			reason: "Protocol",
			issue:
				saved.failure === null
					? "The App action has no saved result."
					: `The App action failed. Error ID: ${saved.failure.errorId}`,
		})
	})
	const client: UiClient = {
		key,
		listTools: (options) =>
			options?.source === "host"
				? decode(specTypeSchemas.ListToolsResult, { tools: opened.tools })
				: read("tools/list", options?.cursor).pipe(
						Effect.flatMap((value) =>
							decode(specTypeSchemas.ListToolsResult, value),
						),
					),
		listResources: (cursor) =>
			read("resources/list", cursor).pipe(
				Effect.flatMap((value) =>
					decode(specTypeSchemas.ListResourcesResult, value),
				),
			),
		listResourceTemplates: (cursor) =>
			read("resources/templates/list", cursor).pipe(
				Effect.flatMap((value) =>
					decode(specTypeSchemas.ListResourceTemplatesResult, value),
				),
			),
		callTool: (input) =>
			Schema.decodeUnknownEffect(Schema.JsonObject)(input.arguments ?? {}).pipe(
				Effect.mapError((error) =>
					ProtocolClient.ClientError.make({
						reason: "Schema",
						issue: `The tool arguments are not a JSON object: ${error.message}`,
					}),
				),
				Effect.flatMap((args) =>
					Effect.flatMap(newCommandKey, (commandKey) =>
						invoke({
							kind: "tool",
							commandKey,
							name: input.name,
							arguments: args,
						}),
					),
				),
				Effect.flatMap(toolResult),
				Effect.map((result) => ({ _tag: "Completed" as const, result })),
			),
		readResource: (input, options) =>
			options?.source === "host" && input.uri === opened.resource.uri
				? Effect.succeed({
						_tag: "Completed" as const,
						result: {
							contents: [
								{
									uri: opened.resource.uri,
									mimeType: opened.resource.mimeType,
									text: opened.resource.html,
								},
							],
						},
					})
				: Effect.flatMap(newCommandKey, (commandKey) =>
						invoke({ kind: "resource", commandKey, uri: input.uri }),
					).pipe(
						Effect.flatMap((value) =>
							decode(specTypeSchemas.ReadResourceResult, value),
						),
						Effect.map((result) => ({ _tag: "Completed" as const, result })),
					),
	}
	return client
})

type Action = (
	| Omit<
			Extract<AppViews.ActionRequest, { readonly kind: "tool" }>,
			"commandKey"
	  >
	| Omit<
			Extract<AppViews.ActionRequest, { readonly kind: "resource" }>,
			"commandKey"
	  >
) & { readonly commandKey?: Execution.CommandKey }

/** Keep one key for an action, including retries after a lost reply. */
export const act = Effect.fn("AppViews.act")(function* (
	viewId: AppViews.AppViewId,
	input: Action,
): Effect.fn.Return<
	Command<AppViews.ActionTicket, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.appViews.act({
				params: { viewId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})

/** A text message uses the same durable Chat command path. */
export const message = Effect.fn("AppViews.message")(function* (
	viewId: AppViews.AppViewId,
	input: {
		readonly content: Schema.JsonObject
		readonly commandKey?: Execution.CommandKey
	},
): Effect.fn.Return<
	Command<AppViews.ActionTicket, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.appViews.message({
				params: { viewId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})
