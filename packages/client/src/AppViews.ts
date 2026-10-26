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
	Match,
	Option,
	Ref,
	Schedule,
	Schema,
} from "effect"
import { Client } from "./Client.ts"

/** The failure of a view request when nothing more is known. */
const failed = () =>
	ProtocolClient.ClientError.make({
		reason: "Protocol",
		issue:
			"The App view request failed. Check its saved operation before you continue.",
	})
const decode = <A>(schema: StandardSchemaV1<unknown, A>, input: unknown) =>
	decodeStandard(() => schema, input, failed)
/** A failure of a request to the App view API. */
type ViewFailure = Effect.Error<
	ReturnType<(typeof Client.Service)["api"]["appViews"]["read"]>
>
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
	return <A>(request: Effect.Effect<A, ViewFailure>) =>
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
type Observation = typeof Api.Observation.Type
/** The statuses after which the status of an action does not change again. */
const Final = Api.Observation.fields.status.pick([
	"Completed",
	"Failed",
	"OutcomeUnknown",
	"Rejected",
])
const isFinal = (
	observed: Observation,
): observed is Observation & { readonly status: typeof Final.Type } =>
	Schema.is(Final)(observed.status)
/** A bridge without credentials, tied to one view that the server owns. Polling never sends an action again. */
export const make = Effect.fn("AppViews.make")(function* (
	opened: Api.Opened,
	owner: string,
	onChange: () => void = () => {},
) {
	const { api } = yield* Client
	const crypto = yield* Crypto.Crypto
	/** A new ID for each action, made when the action runs. */
	const newRequestId = crypto.randomUUIDv4().pipe(Effect.orDie)
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
	/** One span covers the action request and all the polling after it. */
	const invoke = Effect.fn("AppViews.invoke")(function* (
		payload: Api.ActionRequest,
	) {
		const { action, target } =
			payload.kind === "tool"
				? { action: "tools/call", target: payload.name }
				: { action: "resources/read", target: payload.uri }
		yield* Effect.annotateCurrentSpan({ action, target })
		const answer = rejected(action, target)
		// The generated client takes a union of request objects, not one object with a union
		// payload. TypeScript needs each branch narrowed, even though the calls look the same.
		yield* (
			payload.kind === "tool"
				? api.appViews.act({ params, payload })
				: api.appViews.act({ params, payload })
		).pipe(answer)
		const observe = api.appViews
			.operation({ params: { ...params, requestId: payload.requestId } })
			.pipe(answer)
		const seen = yield* Ref.make(Option.none<Observation["status"]>())
		const notify = (observed: Observation) =>
			Ref.getAndSet(seen, Option.some(observed.status)).pipe(
				Effect.flatMap((previous) =>
					Option.contains(previous, observed.status)
						? Effect.void
						: Effect.sync(onChange),
				),
			)
		const observed = yield* observe.pipe(
			Effect.tap(notify),
			Effect.repeat({
				schedule: Schedule.spaced("250 millis"),
				until: isFinal,
			}),
			// With a schedule, the type that `repeat` gives does not see the `until`
			// check, so this checks the status again for the type.
			Effect.filterOrElse(isFinal, () =>
				Effect.die("The App view stopped polling before a final status."),
			),
		)
		const result = observed.operation?.result
		return yield* Match.value(observed.status).pipe(
			Match.when("Completed", () =>
				result?._tag === "Completed"
					? Effect.succeed(result.result)
					: Effect.fail(failed()),
			),
			Match.when("Failed", () =>
				result?._tag !== "Failed"
					? Effect.fail(failed())
					: result.result !== undefined
						? Effect.succeed(result.result)
						: Effect.fail(
								ProtocolClient.ClientError.make({
									reason: "Protocol",
									issue: result.message,
								}),
							),
			),
			Match.when("OutcomeUnknown", () =>
				Effect.fail(
					ProtocolClient.OutcomeUnknown.make({
						key,
						target,
						cause: Option.getOrElse(
							Schema.decodeUnknownOption(
								ProtocolClient.OutcomeUnknown.fields.cause,
							)(result?._tag === "Failed" ? result.cause : undefined),
							() => "Network" as const,
						),
					}),
				),
			),
			Match.when("Rejected", () =>
				Effect.fail(ProtocolClient.PermissionDenied.make({ action, target })),
			),
			Match.exhaustive,
		)
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
					Effect.flatMap(newRequestId, (requestId) =>
						invoke({
							kind: "tool",
							requestId,
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
				: Effect.flatMap(newRequestId, (requestId) =>
						invoke({ kind: "resource", requestId, uri: input.uri }),
					).pipe(
						Effect.flatMap((value) =>
							decode(specTypeSchemas.ReadResourceResult, value),
						),
						Effect.map((result) => ({ _tag: "Completed" as const, result })),
					),
	}
	return client
})
