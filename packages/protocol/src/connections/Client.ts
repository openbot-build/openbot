import * as Mcp from "@modelcontextprotocol/client"
import {
	Cause,
	Context,
	Effect,
	Option,
	Redacted,
	Scope,
	Stream,
	Schema,
} from "effect"
import * as App from "./App.ts"
import * as Store from "./Store.ts"

const inside = Symbol.for("@openbot-build/protocol/Client/inside")

/** Keep the full failure for the host to seal, outside the public error schema. */
export const withCause = <E extends object>(
	error: E,
	cause: Cause.Cause<unknown>,
): E => {
	// Native Error objects need a private field across typed error mapping.
	Object.defineProperty(error, inside, {
		value: Redacted.make(cause),
		enumerable: false,
		configurable: true,
	})
	return error
}

/** Read private diagnostics at a host boundary. Seal them before storage. */
export const errorCause = (
	error: unknown,
): Option.Option<Redacted.Redacted<Cause.Cause<unknown>>> => {
	if (typeof error !== "object" || error === null) return Option.none()
	const saved: unknown = Object.getOwnPropertyDescriptor(error, inside)?.value
	if (!Redacted.isRedacted(saved)) return Option.none()
	const cause = Redacted.value(saved)
	return Cause.isCause(cause)
		? Option.some(Redacted.make(cause))
		: Option.none()
}

/** The MCP methods that list what an App offers. */
export const ListAction = Schema.Literals([
	"tools/list",
	"resources/list",
	"resources/templates/list",
	"prompts/list",
])
export type ListAction = typeof ListAction.Type

/** The MCP methods that run one operation. They can ask for more input. */
export const OperationAction = Schema.Literals([
	"tools/call",
	"resources/read",
	"prompts/get",
])
export type OperationAction = typeof OperationAction.Type

/** Every action that a Client asks its `InvocationPolicy` about. */
export const Action = Schema.Literals([
	"connect",
	...ListAction.literals,
	...OperationAction.literals,
	"subscriptions/listen",
])
export type Action = typeof Action.Type

/** Who may see a tool, as the `ui.visibility` list of the tool says. */
export const ToolVisibility = Schema.Literals(["model", "app"])
export type ToolVisibility = typeof ToolVisibility.Type

/** Who starts a call: the model, an App view, or the host itself. */
export const CallSource = Schema.Literals([...ToolVisibility.literals, "host"])
export type CallSource = typeof CallSource.Type

/** The host may deny its own actions too, so `action` is not only an MCP `Action`. */
export class PermissionDenied extends Schema.TaggedError<
	PermissionDenied,
	{ readonly brand: unique symbol }
>()("PermissionDenied", {
	action: Schema.String,
	target: Schema.String,
}) {}

export class ClientError extends Schema.TaggedError<
	ClientError,
	{ readonly brand: unique symbol }
>()("ClientError", {
	reason: Schema.Literals([
		"Protocol",
		"PolicyUnavailable",
		"Network",
		"Schema",
		"UnsupportedCapability",
		"ConnectionChanged",
		"InputUnavailable",
		"Closed",
	]),
	issue: Schema.String,
}) {}

export class AuthorizationRequired extends Schema.TaggedError<
	AuthorizationRequired,
	{ readonly brand: unique symbol }
>()("AuthorizationRequired", {
	reason: Schema.Literals(["Pending", "Expired", "InsufficientScope"]),
	resourceMetadataUrl: Schema.optional(Schema.String),
	scopes: Schema.Array(Schema.String),
}) {}

export class OutcomeUnknown extends Schema.TaggedError<
	OutcomeUnknown,
	{ readonly brand: unique symbol }
>()("OutcomeUnknown", {
	key: Store.ConnectionKey,
	target: Schema.String,
	cause: Schema.Literals(["Network", "Protocol", "Schema", "Closed"]),
}) {}

/** The SDK type of a tool result. The Client checks the result before it makes this error. */
const CallToolResult = Schema.declare(Mcp.isCallToolResult)

export class ToolFailure extends Schema.TaggedError<
	ToolFailure,
	{ readonly brand: unique symbol }
>()("ToolFailure", {
	result: CallToolResult,
}) {}

export interface Invocation {
	readonly connection: Store.UserConnection
	readonly action: Action
	readonly target: string
	readonly arguments: unknown
	readonly source: CallSource
}

export class InvocationPolicy extends Context.Service<
	InvocationPolicy,
	{
		readonly check: (
			invocation: Invocation,
		) => Effect.Effect<void, PermissionDenied | ClientError>
	}
>()("@openbot-build/protocol/connections/Client/InvocationPolicy") {}

export type Error =
	| ClientError
	| AuthorizationRequired
	| PermissionDenied
	| OutcomeUnknown
	| ToolFailure
	| Store.StoreError
	| App.AppError

export interface CallOptions {
	readonly source: CallSource
	/** A business guarantee from the host, not an untrusted tool hint. By default, the call may write. */
	readonly readOnly?: boolean
	readonly timeoutMs?: number
	readonly onprogress?: Mcp.ProgressCallback
}

export interface InputHandler {
	readonly capabilities: Mcp.ClientCapabilities
	readonly handle: (
		request: Mcp.InputRequest,
	) => Effect.Effect<Mcp.InputResponse, ClientError>
}

export type OperationResult<A> =
	| { readonly _tag: "Completed"; readonly result: A }
	| {
			readonly _tag: "InputRequired"
			readonly result: Mcp.InputRequiredResult
			readonly respond: (
				responses: Mcp.InputResponses,
			) => Effect.Effect<OperationResult<A>, Error>
			readonly handle: Effect.Effect<OperationResult<A>, Error>
	  }

/** A serializable link to an MRTR (multi-round-trip request) operation. Hosts must store it with the original operation. */
export const Continuation = Schema.Struct({
	method: OperationAction,
	params: Schema.JsonObject,
	request: Schema.JsonObject,
})
export type Continuation = typeof Continuation.Type

export interface Client {
	readonly resume: (
		continuation: Continuation,
		responses: Schema.JsonObject,
		options: CallOptions,
	) => Effect.Effect<OperationResult<unknown>, Error>
	readonly key: Store.ConnectionKey
	readonly discovery: Mcp.DiscoverResult
	readonly notifications: Stream.Stream<Mcp.Notification>
	readonly listTools: (options?: {
		readonly cursor?: string
		readonly source?: CallOptions["source"]
		readonly refresh?: boolean
		readonly singlePage?: boolean
	}) => Effect.Effect<Mcp.ListToolsResult, Error>
	readonly modelTools: Effect.Effect<ReadonlyArray<Mcp.Tool>, Error>
	readonly listResources: (
		cursor?: string,
		source?: CallOptions["source"],
		options?: { readonly singlePage?: boolean },
	) => Effect.Effect<Mcp.ListResourcesResult, Error>
	readonly listResourceTemplates: (
		cursor?: string,
		source?: CallOptions["source"],
		options?: { readonly singlePage?: boolean },
	) => Effect.Effect<Mcp.ListResourceTemplatesResult, Error>
	readonly listPrompts: (
		cursor?: string,
		source?: CallOptions["source"],
		options?: { readonly singlePage?: boolean },
	) => Effect.Effect<Mcp.ListPromptsResult, Error>
	readonly callTool: (
		params: Mcp.CallToolRequest["params"],
		options: CallOptions,
	) => Effect.Effect<OperationResult<Mcp.CallToolResult>, Error>
	readonly readResource: (
		params: Mcp.ReadResourceRequest["params"],
		options: CallOptions,
	) => Effect.Effect<OperationResult<Mcp.ReadResourceResult>, Error>
	readonly readTemplate: (options: {
		readonly template: string
		readonly values: Mcp.Variables
		readonly source: CallOptions["source"]
	}) => Effect.Effect<OperationResult<Mcp.ReadResourceResult>, Error>
	readonly getPrompt: (
		params: Mcp.GetPromptRequest["params"],
		options: CallOptions,
	) => Effect.Effect<OperationResult<Mcp.GetPromptResult>, Error>
	readonly listen: (filter: Mcp.SubscriptionFilter) => Effect.Effect<
		{
			readonly honoredFilter: Mcp.SubscriptionFilter
			readonly closed: Effect.Effect<
				"local" | "graceful" | "remote",
				ClientError
			>
			readonly close: Effect.Effect<void, Error>
		},
		Error,
		Scope.Scope
	>
	readonly close: Effect.Effect<void>
}
