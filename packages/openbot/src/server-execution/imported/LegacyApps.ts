import { Schema } from "effect"

/** Private saved forms at 2a123ff. Do not replace these with HTTP or current product schemas. */
export const Source = Schema.Struct({
	connectionId: Schema.NonEmptyString,
	connectionName: Schema.String,
	cardUrl: Schema.NonEmptyString,
	appName: Schema.String,
	remoteIndex: Schema.Natural,
	revision: Schema.Natural,
	kind: Schema.Literals(["tool", "resource", "template", "prompt"]),
	name: Schema.String,
	definition: Schema.optionalKey(Schema.Json),
})
export type Source = typeof Source.Type
export const Result = Schema.TaggedUnion({
	Completed: {
		source: Source,
		result: Schema.Json,
		operationId: Schema.optionalKey(Schema.NonEmptyString),
	},
	InputRequired: {
		source: Source,
		request: Schema.Json,
		operationId: Schema.optionalKey(Schema.NonEmptyString),
	},
	Failed: {
		source: Source,
		reason: Schema.String,
		cause: Schema.optionalKey(Schema.String),
		message: Schema.String,
		result: Schema.optionalKey(Schema.Json),
		operationId: Schema.optionalKey(Schema.NonEmptyString),
	},
})
export type Result = typeof Result.Type

export const InvocationStatus = Schema.Literals([
	"PendingApproval",
	"Approved",
	"Rejected",
	"Sending",
	"InputRequired",
	"Completed",
	"Failed",
	"OutcomeUnknown",
])
export type InvocationStatus = typeof InvocationStatus.Type
export const Invocation = Schema.Struct({
	id: Schema.NonEmptyString,
	chat: Schema.NonEmptyString,
	turn: Schema.NonEmptyString,
	callId: Schema.String,
	toolName: Schema.String,
	source: Source,
	arguments: Schema.JsonObject,
	readOnly: Schema.Boolean,
	round: Schema.Natural,
	status: InvocationStatus,
	result: Schema.NullOr(Result),
})
export type Invocation = typeof Invocation.Type

export const CallOutcome = Schema.TaggedUnion({
	/** The call waits for a decision. */
	Waiting: {},
	/** A decider said no. The program got an error for this call. */
	Denied: { reason: Schema.String },
	/** The call ran. This is the App result that the program got. */
	Done: { result: Result },
})
export type CallOutcome = typeof CallOutcome.Type

export const CodeCall = Schema.Struct({
	/** The place of the call in the program, from 0. */
	index: Schema.Natural,
	/** The name that the program used, such as `apps.calendar.list_events`. */
	binding: Schema.String,
	source: Source,
	/** The App operation of the call. Read it at `/v1/app-operations/:id`. */
	operationId: Schema.optionalKey(Schema.NonEmptyString),
	outcome: CallOutcome,
})
export type CodeCall = typeof CodeCall.Type

export const FailureReason = Schema.Literals([
	/** The program threw an error that it did not catch. */
	"Error",
	"Timeout",
	"Memory",
	/** The program sent back more output than the platform allows. */
	"OutputTooLarge",
	/** The program made other calls than the last time it ran, so OpenBot stopped it. */
	"ReplayMismatch",
	"Cancelled",
	/** OpenBot could not run or save the program. */
	"Unavailable",
])
export type FailureReason = typeof FailureReason.Type

/** The end of a program. The Bot gets this as the result of its tool call. */
export const CodeResult = Schema.TaggedUnion({
	Completed: {
		/** The value that the program returned, as JSON. */
		value: Schema.Json,
		logs: Schema.Array(Schema.String),
	},
	Failed: {
		reason: FailureReason,
		message: Schema.String,
		logs: Schema.Array(Schema.String),
	},
})
export type CodeResult = typeof CodeResult.Type

export const CodeRunStatus = Schema.Literals([
	"Running",
	"Waiting",
	"Completed",
	"Failed",
	"Cancelled",
])
export type CodeRunStatus = typeof CodeRunStatus.Type

/** One program and all its App calls. */
export const CodeRun = Schema.Struct({
	id: Schema.NonEmptyString,
	chat: Schema.NonEmptyString,
	turn: Schema.NonEmptyString,
	/** The tool call of the Bot that started the program. */
	callId: Schema.String,
	status: CodeRunStatus,
	code: Schema.String,
	/** Why the Bot runs the program, in its own words. */
	reason: Schema.String,
	calls: Schema.Array(CodeCall),
	result: Schema.NullOr(CodeResult),
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type CodeRun = typeof CodeRun.Type

export const Run = Schema.Struct({
	...CodeRun.fields,
	calls: Schema.Array(
		Schema.Struct({ ...CodeCall.fields, argumentsHash: Schema.String }),
	),
	seed: Schema.Int,
	clock: Schema.Finite,
	organizationId: Schema.String,
	userId: Schema.String,
})
export const Binding = Schema.Struct({
	owner: Schema.NonEmptyString,
	connectionId: Schema.NonEmptyString,
	resource: Schema.NonEmptyString,
	issuer: Schema.NonEmptyString,
})
/** These are JSON codecs after the old Redacted fields were encoded. */
export const Credential = Schema.Struct({
	binding: Binding,
	clientId: Schema.optionalKey(Schema.String),
	accessToken: Schema.NonEmptyString,
	refreshToken: Schema.optionalKey(Schema.NonEmptyString),
	expiresAt: Schema.optionalKey(Schema.Finite),
	scopes: Schema.Array(Schema.String),
})
const ServerMetadata = Schema.StructWithRest(
	Schema.Struct({
		issuer: Schema.NonEmptyString,
		authorization_endpoint: Schema.NonEmptyString,
		token_endpoint: Schema.NonEmptyString,
		revocation_endpoint: Schema.optionalKey(Schema.String),
		client_id_metadata_document_supported: Schema.optionalKey(Schema.Boolean),
		authorization_response_iss_parameter_supported: Schema.optionalKey(
			Schema.Boolean,
		),
		code_challenge_methods_supported: Schema.Array(Schema.String),
		response_types_supported: Schema.Array(Schema.String),
		token_endpoint_auth_methods_supported: Schema.optionalKey(
			Schema.Array(Schema.String),
		),
	}),
	[Schema.Record(Schema.String, Schema.Json)],
)
export const Flow = Schema.Struct({
	flowId: Schema.String,
	binding: Binding,
	clientId: Schema.String,
	redirectUri: Schema.String,
	scopes: Schema.Array(Schema.String),
	verifier: Schema.String,
	expiresAt: Schema.Finite,
	metadata: ServerMetadata,
	resourceMetadataUrl: Schema.optionalKey(Schema.String),
})
const Authorization = Schema.TaggedUnion({
	Unprotected: {},
	PendingAuthorization: {
		resource: Schema.String,
		scopes: Schema.Array(Schema.String),
	},
	Authorized: {
		binding: Binding,
		credentialRef: Schema.String,
		scopes: Schema.Array(Schema.String),
		resourceMetadataUrl: Schema.optionalKey(Schema.String),
	},
	AuthorizationFailed: { reason: Schema.String },
	ScopeRequired: {
		resource: Schema.String,
		scopes: Schema.Array(Schema.String),
	},
})
export const Connection = Schema.Struct({
	owner: Schema.NonEmptyString,
	connectionId: Schema.NonEmptyString,
	cardUrl: Schema.String,
	endpoint: Schema.String,
	remoteIndex: Schema.Natural,
	configuration: Schema.Record(Schema.String, Schema.String),
	headers: Schema.Record(Schema.String, Schema.String),
	state: Schema.Literals([
		"Enabled",
		"Disabled",
		"NeedsRevalidation",
		"CleanupPending",
	]),
	authorization: Authorization,
})
export const PrivateTest = Schema.Struct({
	connection: Schema.NullOr(Connection),
	credentials: Schema.Array(
		Schema.Struct({ reference: Schema.String, credential: Credential }),
	),
})
export const TestAuthorization = Schema.Struct({
	flowId: Schema.String,
	status: Schema.Literals([
		"Waiting",
		"Received",
		"Exchanging",
		"Succeeded",
		"Failed",
		"Cancelled",
		"Expired",
	]),
	issuer: Schema.String,
	resource: Schema.String,
	scopes: Schema.Array(Schema.String),
	expiresAt: Schema.Finite,
	authorizationUrl: Schema.String,
})
const Candidate = Schema.Struct({
	cardUrl: Schema.String,
	card: Schema.StructWithRest(
		Schema.Struct({
			name: Schema.NonEmptyString,
			version: Schema.NonEmptyString,
		}),
		[Schema.Record(Schema.String, Schema.Json)],
	),
	endpoints: Schema.Array(
		Schema.Struct({
			index: Schema.Natural,
			remote: Schema.StructWithRest(
				Schema.Struct({
					type: Schema.Literals(["streamable-http", "sse"]),
					url: Schema.NonEmptyString,
				}),
				[Schema.Record(Schema.String, Schema.Json)],
			),
			requirements: Schema.Array(
				Schema.Struct({
					key: Schema.String,
					description: Schema.optionalKey(Schema.String),
					isSecret: Schema.Boolean,
					format: Schema.optionalKey(Schema.String),
					choices: Schema.optionalKey(Schema.Array(Schema.String)),
				}),
			),
		}),
	),
	sources: Schema.Array(
		Schema.Struct({
			role: Schema.Literals([
				"input",
				"page",
				"catalog",
				"card",
				"endpoint",
				"manual",
			]),
			url: Schema.String,
			originalInput: Schema.optionalKey(Schema.String),
		}),
	),
})
export const Test = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.String,
	candidate: Candidate,
	remoteIndex: Schema.Natural,
	endpoint: Schema.NullOr(Schema.String),
	configurationKeys: Schema.Array(Schema.String),
	issuers: Schema.Array(Schema.String),
	requestedScopes: Schema.Array(Schema.String),
	createdAt: Schema.Finite,
	expiresAt: Schema.Finite,
	status: Schema.Literals([
		"Queued",
		"Running",
		"AwaitingConfiguration",
		"AwaitingAuthorization",
		"Succeeded",
		"Failed",
		"Cancelled",
		"Interrupted",
	]),
	checkedAt: Schema.NullOr(Schema.Finite),
	stages: Schema.Array(
		Schema.Struct({
			stage: Schema.Literals([
				"configuration",
				"initialize",
				"tools",
				"resources",
				"templates",
				"prompts",
			]),
			status: Schema.Literals([
				"Passed",
				"Failed",
				"NotAdvertised",
				"NotChecked",
			]),
			items: Schema.Array(Schema.JsonObject),
			reason: Schema.NullOr(Schema.String),
		}),
	),
	cleanup: Schema.Literals(["NotRequired", "Pending", "Complete"]),
	cleanupRemote: Schema.Literals([
		"NotRequired",
		"Pending",
		"Complete",
		"LocalOnly",
	]),
	cleanupLocal: Schema.Literals(["Pending", "Complete"]),
	authorization: Schema.NullOr(TestAuthorization),
	reason: Schema.NullOr(Schema.String),
})
export const AuthorizationRow = Schema.Struct({
	id: Schema.NonEmptyString,
	owner: Schema.NonEmptyString,
	connection_id: Schema.NonEmptyString,
	revision: Schema.Natural,
	expires_at: Schema.FiniteFromString,
	return_to: Schema.String,
	status: Schema.Literals([
		"Waiting",
		"Received",
		"Processing",
		"Succeeded",
		"Cancelled",
		"Failed",
	]),
	callback: Schema.NullOr(Schema.String),
	reason: Schema.NullOr(Schema.String),
	issuer: Schema.NonEmptyString,
	resource: Schema.String,
	scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
})

export const View = Schema.Struct({
	id: Schema.String,
	operationId: Schema.String,
	readOnly: Schema.Boolean,
	chat: Schema.String,
	turn: Schema.String,
	item: Schema.String,
	connectionId: Schema.String,
	revision: Schema.Natural,
	expiresAt: Schema.Finite,
})
export const ViewAction = Schema.Struct({
	requestId: Schema.String,
	kind: Schema.Literals(["tool", "resource"]),
	target: Schema.String,
	arguments: Schema.JsonObject,
	ticket: Schema.NullOr(
		Schema.Struct({
			chat: Schema.String,
			turn: Schema.String,
			item: Schema.String,
			callId: Schema.String,
			revision: Schema.Natural,
		}),
	),
})
export const ViewState = Schema.Struct({
	revision: Schema.Natural,
	context: Schema.NullOr(Schema.JsonObject),
})
