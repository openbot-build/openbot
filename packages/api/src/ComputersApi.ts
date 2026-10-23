import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { AgentId } from "./AgentsApi.ts"
import { AgentAuth } from "./AuthApi.ts"
import { Authorize, GroupRequired, PermissionErrors } from "./Permissions.ts"
import { PublicOrigin, SecretInput, SecretState, Version } from "./Settings.ts"

export const ComputerId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/ComputerId"))
export type ComputerId = typeof ComputerId.Type

export const ComputerProviderId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/ComputerProviderId"))
export type ComputerProviderId = typeof ComputerProviderId.Type

/**
 * A member owns their own Computers and Computer providers. Only they and their
 * Agents can use them. The organization owns shared ones. Policies decide who can use them.
 */
export const ComputerOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
})
export type ComputerOwner = typeof ComputerOwner.Type

/**
 * The service that runs Computers.
 * `e2b` is any service that speaks the E2B API, such as E2B, PPIO, Alibaba Cloud Agent
 * Sandbox, or a self-hosted E2B. `daytona` is Daytona, hosted or self-hosted.
 */
export const ComputerProviderKind = Schema.Literals(["e2b", "daytona"])
export type ComputerProviderKind = typeof ComputerProviderKind.Type

/** The secrets of a Computer provider. They go in, but they never come out. */
export const ComputerProviderCredentials = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("e2b"),
		apiKey: SecretInput,
		/** The platform API. Without it, OpenBot uses `https://api.e2b.app`. */
		apiUrl: Schema.optionalKey(PublicOrigin),
		/** The domain of the sandbox hosts. Without it, OpenBot uses `e2b.app`. */
		sandboxDomain: Schema.optionalKey(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
		),
	}),
	Schema.Struct({
		kind: Schema.Literal("daytona"),
		apiKey: SecretInput,
		/** Without it, OpenBot uses the hosted Daytona. */
		apiUrl: Schema.optionalKey(PublicOrigin),
		/** The region where Daytona runs the Computers, such as `us` or `eu`. */
		target: Schema.optionalKey(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
		),
	}),
])
export type ComputerProviderCredentials =
	typeof ComputerProviderCredentials.Type

/** What the API shows of the secrets of a Computer provider. */
export const ComputerProviderCredentialsView = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("e2b"),
		apiKey: SecretState,
		apiUrl: Schema.NullOr(Schema.String),
		sandboxDomain: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("daytona"),
		apiKey: SecretState,
		apiUrl: Schema.NullOr(Schema.String),
		target: Schema.NullOr(Schema.String),
	}),
])
export type ComputerProviderCredentialsView =
	typeof ComputerProviderCredentialsView.Type

/**
 * An account at a service that runs Computers. The service bills its owner
 * directly. OpenBot only records how long each Computer runs.
 */
export const ComputerProvider = Schema.Struct({
	id: ComputerProviderId,
	kind: ComputerProviderKind,
	name: Schema.String,
	owner: ComputerOwner,
	credentials: ComputerProviderCredentialsView,
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type ComputerProvider = typeof ComputerProvider.Type

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))

export const CreateComputerProviderRequest = Schema.Struct({
	name: Name,
	credentials: ComputerProviderCredentials,
	/** Shared providers belong to the organization. Other providers belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
})
export type CreateComputerProviderRequest =
	typeof CreateComputerProviderRequest.Type

export const UpdateComputerProviderRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(Name),
	/** Leave it out to keep the current secrets. The kind cannot change. */
	credentials: Schema.optionalKey(ComputerProviderCredentials),
})
export type UpdateComputerProviderRequest =
	typeof UpdateComputerProviderRequest.Type

/**
 * Where a Computer runs.
 * `Provider` is a sandbox at a Computer provider, made from a template of that provider.
 * `Connector` is a machine of your own. It runs `openbot computer connect`, which keeps
 * a connection open to OpenBot, so the machine needs no open inbound port.
 */
export const ComputerSource = Schema.TaggedUnion({
	Provider: {
		provider: ComputerProviderId,
		/** A template or image of the provider. Without it, OpenBot uses the default of the provider. */
		template: Schema.NullOr(Schema.String),
	},
	Connector: {},
})
export type ComputerSource = typeof ComputerSource.Type

/**
 * `starting`: OpenBot asked the provider for the Computer, and it is not ready yet.
 * `running`: commands work.
 * `paused`: the provider keeps the files, and does not bill for CPU.
 *   Any command resumes the Computer first.
 * `offline`: the connector of the machine is not connected.
 * `failed`: the provider lost the Computer. Only delete works.
 */
export const ComputerState = Schema.Literals([
	"starting",
	"running",
	"paused",
	"offline",
	"failed",
])
export type ComputerState = typeof ComputerState.Type

/** What a Computer can do beyond commands and files. */
export const ComputerFeatures = Schema.Struct({
	/** It can pause and resume. */
	pause: Schema.Boolean,
	/** It has a desktop for screenshots, the mouse and the keyboard. */
	desktop: Schema.Boolean,
	/** It can give a port of the Computer a public HTTPS address. */
	ports: Schema.Boolean,
})
export type ComputerFeatures = typeof ComputerFeatures.Type

/** The longest time that a Computer can stay idle before OpenBot pauses it. */
const PauseAfter = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(60),
	Schema.isLessThanOrEqualTo(7 * 24 * 60 * 60),
)

/**
 * A machine where Agents run commands, change files and use a desktop.
 * A member or the organization owns it. Agents never own a Computer. They get the
 * right to use it (see `ComputerAccess`). Work inside a Computer needs no review,
 * because the Computer is the boundary.
 */
export const Computer = Schema.Struct({
	id: ComputerId,
	name: Schema.String,
	owner: ComputerOwner,
	source: ComputerSource,
	state: ComputerState,
	features: ComputerFeatures,
	/** Seconds without work before OpenBot pauses the Computer. `null` never pauses it. */
	pauseAfter: Schema.NullOr(PauseAfter),
	/** The member that made the Computer, or the Agent that made it for its member. */
	createdBy: Schema.String,
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
	lastActiveAt: Schema.NullOr(Schema.Finite),
})
export type Computer = typeof Computer.Type

export const CreateComputerRequest = Schema.Struct({
	name: Name,
	source: ComputerSource,
	/** Ask for a desktop. The provider must have a desktop template. */
	desktop: Schema.optionalKey(Schema.Boolean),
	pauseAfter: Schema.optionalKey(Schema.NullOr(PauseAfter)),
	/** Shared Computers belong to the organization. Other Computers belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
})
export type CreateComputerRequest = typeof CreateComputerRequest.Type

export const UpdateComputerRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(Name),
	pauseAfter: Schema.optionalKey(Schema.NullOr(PauseAfter)),
})
export type UpdateComputerRequest = typeof UpdateComputerRequest.Type

/**
 * The right of one Agent to use one Computer. Many Agents can use one Computer.
 * Only the Agent with the right can use it. Its child Agents ask for their own right.
 * The right ends when the Agent is archived. The Computer stays.
 */
export const ComputerAccess = Schema.Struct({
	computer: ComputerId,
	agent: AgentId,
	/** The member who gave the right, or who answered the request of the Agent. */
	grantedBy: Schema.String,
	grantedAt: Schema.Finite,
})
export type ComputerAccess = typeof ComputerAccess.Type

/** How long a Computer ran. `endedAt` is `null` while it still runs. */
export const ComputerUsage = Schema.Struct({
	computer: ComputerId,
	startedAt: Schema.Finite,
	endedAt: Schema.NullOr(Schema.Finite),
	seconds: Schema.Finite,
})
export type ComputerUsage = typeof ComputerUsage.Type

/** The secret that `openbot computer connect` uses. OpenBot shows it only once. */
export const ConnectorToken = Schema.Struct({ token: Schema.String })
export type ConnectorToken = typeof ConnectorToken.Type

const Path = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4096),
)

export const RunCommandRequest = Schema.Struct({
	/** A shell command. It runs with `bash -lc`. */
	command: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(100_000),
	),
	cwd: Schema.optionalKey(Path),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/** Seconds. OpenBot stops the command after this time. The default is 60. */
	timeout: Schema.optionalKey(
		Schema.Int.check(
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(3600),
		),
	),
})
export type RunCommandRequest = typeof RunCommandRequest.Type

export const CommandResult = Schema.Struct({
	/** `null` when OpenBot stopped the command at its timeout. */
	exitCode: Schema.NullOr(Schema.Int),
	stdout: Schema.String,
	stderr: Schema.String,
	/** True when the output was too long and OpenBot kept only its end. */
	truncated: Schema.Boolean,
	durationMs: Schema.Finite,
})
export type CommandResult = typeof CommandResult.Type

/** `utf8` for text. `base64` for any other bytes. */
export const FileEncoding = Schema.Literals(["utf8", "base64"])
export type FileEncoding = typeof FileEncoding.Type

export const FileContent = Schema.Struct({
	path: Path,
	encoding: FileEncoding,
	content: Schema.String,
})
export type FileContent = typeof FileContent.Type

export const FileEntry = Schema.Struct({
	name: Schema.String,
	kind: Schema.Literals(["file", "directory", "link"]),
	size: Schema.Finite,
	modifiedAt: Schema.Finite,
})
export type FileEntry = typeof FileEntry.Type

const Port = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(65535),
)

/** A public HTTPS address for a port of a Computer. Anyone with the address can use it. */
export const OpenPort = Schema.Struct({
	port: Port,
	url: Schema.String,
})
export type OpenPort = typeof OpenPort.Type

const Coordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const MouseButton = Schema.Literals(["left", "right", "middle"])

/** One action on the desktop. Coordinates are pixels of the last screenshot. */
export const DesktopAction = Schema.TaggedUnion({
	Click: {
		x: Coordinate,
		y: Coordinate,
		button: Schema.optionalKey(MouseButton),
		double: Schema.optionalKey(Schema.Boolean),
	},
	Move: { x: Coordinate, y: Coordinate },
	Drag: {
		fromX: Coordinate,
		fromY: Coordinate,
		toX: Coordinate,
		toY: Coordinate,
	},
	Scroll: {
		x: Coordinate,
		y: Coordinate,
		deltaX: Schema.Int,
		deltaY: Schema.Int,
	},
	Type: { text: Schema.String.check(Schema.isMaxLength(10_000)) },
	/** Keys to press together, such as `["ctrl", "c"]`. */
	Key: {
		keys: Schema.Array(Schema.String.check(Schema.isMaxLength(32))).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(5),
		),
	},
})
export type DesktopAction = typeof DesktopAction.Type

export const Screenshot = Schema.Struct({
	mediaType: Schema.Literal("image/png"),
	/** Base64 bytes of the image. */
	data: Schema.String,
	width: Schema.Int,
	height: Schema.Int,
})
export type Screenshot = typeof Screenshot.Type

/** An address where a person can watch and use the desktop, such as a VNC page. */
export const DesktopStream = Schema.Struct({
	url: Schema.String,
	expiresAt: Schema.NullOr(Schema.Finite),
})
export type DesktopStream = typeof DesktopStream.Type

/**
 * A call that OpenBot sends to a connector. The connector answers each call with a
 * `ConnectorReply` with the same `id`. Calls can run at the same time.
 */
export const ConnectorCall = Schema.Struct({
	id: Schema.String,
	operation: Schema.TaggedUnion({
		Run: { request: RunCommandRequest },
		Read: { path: Path, encoding: FileEncoding },
		Write: { file: FileContent },
		List: { path: Path },
		Remove: { path: Path },
		Screenshot: {},
		Desktop: { actions: Schema.Array(DesktopAction) },
	}),
})
export type ConnectorCall = typeof ConnectorCall.Type

export const ConnectorReply = Schema.Struct({
	id: Schema.String,
	result: Schema.TaggedUnion({
		Done: { value: Schema.Json },
		Failed: { message: Schema.String },
	}),
})
export type ConnectorReply = typeof ConnectorReply.Type

/** The first message of a connector. It tells OpenBot what the machine can do. */
export const ConnectorHello = Schema.Struct({
	version: Schema.String,
	os: Schema.String,
	arch: Schema.String,
	desktop: Schema.Boolean,
})
export type ConnectorHello = typeof ConnectorHello.Type

/**
 * A message from OpenBot to a connector. Each WebSocket text frame holds one message as JSON.
 * OpenBot sends `Ping` every 20 seconds. The connector answers with `Pong`.
 */
export const ToConnector = Schema.TaggedUnion({
	Call: { call: ConnectorCall },
	Ping: {},
})
export type ToConnector = typeof ToConnector.Type

/** A message from a connector to OpenBot. The first message must be `Hello`. */
export const FromConnector = Schema.TaggedUnion({
	Hello: { hello: ConnectorHello },
	Reply: { reply: ConnectorReply },
	Pong: {},
})
export type FromConnector = typeof FromConnector.Type

export const PairingId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/PairingId"))
export type PairingId = typeof PairingId.Type

/**
 * A short code that a machine shows to the person who pairs it, such as `KDTW-7Q3M`.
 * The person gives it to OpenBot to approve the machine.
 */
export const PairingCode = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(32),
)

/** What `openbot computer pair` tells OpenBot about the machine. */
export const StartPairingRequest = Schema.Struct({
	...ConnectorHello.fields,
	hostname: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
	/**
	 * A random ID that the machine makes once and keeps. When the same machine pairs
	 * again in the same organization, it keeps its Computer and gets a new token.
	 */
	machineId: Schema.String.check(
		Schema.isMinLength(16),
		Schema.isMaxLength(128),
	),
})
export type StartPairingRequest = typeof StartPairingRequest.Type

/**
 * A new pairing. The machine shows the `code` to the person, then polls with the
 * `secret` every `interval` seconds until the person approves or the pairing ends.
 */
export const Pairing = Schema.Struct({
	id: PairingId,
	code: Schema.String,
	secret: Schema.String,
	interval: Schema.Int,
	expiresAt: Schema.Finite,
})
export type Pairing = typeof Pairing.Type

/** `Approved` comes only once. Then the machine keeps the token and connects with it. */
export const PairingStatus = Schema.TaggedUnion({
	Pending: {},
	Approved: { computer: ComputerId, token: Schema.String },
})
export type PairingStatus = typeof PairingStatus.Type

/** What the person sees before they approve, so they can check that it is their machine. */
export const ComputerPairing = Schema.Struct({
	code: Schema.String,
	hostname: Schema.String,
	os: Schema.String,
	arch: Schema.String,
	desktop: Schema.Boolean,
	expiresAt: Schema.Finite,
})
export type ComputerPairing = typeof ComputerPairing.Type

export const ApprovePairingRequest = Schema.Struct({
	/** Without it, the name of the Computer is the hostname of the machine. */
	name: Schema.optionalKey(Name),
	/** Shared Computers belong to the organization. Other Computers belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
})
export type ApprovePairingRequest = typeof ApprovePairingRequest.Type

export class ComputerNotFound extends Schema.TaggedError<ComputerNotFound>()(
	"ComputerNotFound",
	{ id: Schema.String },
) {}
export class ComputerProviderNotFound extends Schema.TaggedError<ComputerProviderNotFound>()(
	"ComputerProviderNotFound",
	{ id: Schema.String },
) {}
export class ComputerConflict extends Schema.TaggedError<ComputerConflict>()(
	"ComputerConflict",
	{ version: Version },
) {}
export class ComputerInvalid extends Schema.TaggedError<ComputerInvalid>()(
	"ComputerInvalid",
	{ message: Schema.String },
) {}
/** The Computer cannot do this, such as a desktop action on a Computer without a desktop. */
export class ComputerUnsupported extends Schema.TaggedError<ComputerUnsupported>()(
	"ComputerUnsupported",
	{ feature: Schema.String },
) {}
/** The Computer is offline or failed. */
export class ComputerNotReady extends Schema.TaggedError<ComputerNotReady>()(
	"ComputerNotReady",
	{ state: ComputerState },
) {}
/** The provider refused the call or did not answer. */
export class ComputerProviderFailed extends Schema.TaggedError<ComputerProviderFailed>()(
	"ComputerProviderFailed",
	{ message: Schema.String },
) {}
export class ComputersUnavailable extends Schema.TaggedError<ComputersUnavailable>()(
	"ComputersUnavailable",
	{},
) {}
/** The token is wrong, or the Computer is not a connector Computer. */
export class ConnectorDenied extends Schema.TaggedError<ConnectorDenied>()(
	"ConnectorDenied",
	{},
) {}
/** The pairing is unknown, denied, used or too old. Run `openbot computer pair` again. */
export class PairingInvalid extends Schema.TaggedError<PairingInvalid>()(
	"PairingInvalid",
	{},
) {}

export const ComputerErrors = [
	...PermissionErrors,
	ComputerNotFound.pipe(HttpApiSchema.status(404)),
	ComputerProviderNotFound.pipe(HttpApiSchema.status(404)),
	ComputerConflict.pipe(HttpApiSchema.status(409)),
	ComputerInvalid.pipe(HttpApiSchema.status(400)),
	ComputerUnsupported.pipe(HttpApiSchema.status(409)),
	ComputerNotReady.pipe(HttpApiSchema.status(409)),
	ComputerProviderFailed.pipe(HttpApiSchema.status(502)),
	ComputersUnavailable.pipe(HttpApiSchema.status(503)),
	PairingInvalid.pipe(HttpApiSchema.status(404)),
] as const

const providerParams = { providerId: ComputerProviderId }
const computerParams = { computerId: ComputerId }

export class ComputerProvidersApi extends HttpApiGroup.make("computerProviders")
	.add(
		HttpApiEndpoint.get("listComputerProviders", "/v1/computer-providers", {
			success: Schema.Array(ComputerProvider),
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Computer providers that the caller can use: their own and the shared ones.",
		),
		HttpApiEndpoint.post("createComputerProvider", "/v1/computer-providers", {
			payload: CreateComputerProviderRequest,
			success: ComputerProvider.pipe(HttpApiSchema.status(201)),
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Adds an account at a Computer provider. OpenBot checks the key with the provider first.",
		),
		HttpApiEndpoint.get(
			"getComputerProvider",
			"/v1/computer-providers/:providerId",
			{
				params: providerParams,
				success: ComputerProvider,
				error: ComputerErrors,
			},
		),
		HttpApiEndpoint.patch(
			"updateComputerProvider",
			"/v1/computer-providers/:providerId",
			{
				params: providerParams,
				payload: UpdateComputerProviderRequest,
				success: ComputerProvider,
				error: ComputerErrors,
			},
		),
		HttpApiEndpoint.delete(
			"deleteComputerProvider",
			"/v1/computer-providers/:providerId",
			{
				params: providerParams,
				success: HttpApiSchema.NoContent,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Deletes a Computer provider. It fails while Computers still use it.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key depends on the owner, which the path does not show.
	// So the handlers check the permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(AgentAuth) {}

export class ComputersApi extends HttpApiGroup.make("computers")
	.add(
		HttpApiEndpoint.get("listComputers", "/v1/computers", {
			query: { agent: Schema.optionalKey(AgentId) },
			success: Schema.Array(Computer),
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Computers that the caller can use: their own and the shared ones. With `agent`, it lists only the Computers that this Agent has the right to use.",
		),
		HttpApiEndpoint.post("createComputer", "/v1/computers", {
			payload: CreateComputerRequest,
			success: Computer.pipe(HttpApiSchema.status(201)),
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Creates a Computer. A provider Computer starts at once. A connector Computer stays `offline` until its connector connects.",
		),
		HttpApiEndpoint.get("getComputer", "/v1/computers/:computerId", {
			params: computerParams,
			success: Computer,
			error: ComputerErrors,
		}),
		HttpApiEndpoint.patch("updateComputer", "/v1/computers/:computerId", {
			params: computerParams,
			payload: UpdateComputerRequest,
			success: Computer,
			error: ComputerErrors,
		}),
		HttpApiEndpoint.delete("deleteComputer", "/v1/computers/:computerId", {
			params: computerParams,
			success: HttpApiSchema.NoContent,
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Deletes a Computer, its sandbox at the provider, and the rights of all Agents to use it. The files are gone. For a connector Computer, the connector is disconnected.",
		),
		HttpApiEndpoint.get(
			"listComputerAgents",
			"/v1/computers/:computerId/agents",
			{
				params: computerParams,
				success: Schema.Array(ComputerAccess),
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Lists the Agents that have the right to use a Computer.",
		),
		HttpApiEndpoint.put(
			"grantComputer",
			"/v1/computers/:computerId/agents/:agentId",
			{
				params: { computerId: ComputerId, agentId: AgentId },
				success: ComputerAccess,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Gives an Agent the right to use a Computer. The caller must be able to use the Computer and to change the Agent.",
		),
		HttpApiEndpoint.delete(
			"revokeComputer",
			"/v1/computers/:computerId/agents/:agentId",
			{
				params: { computerId: ComputerId, agentId: AgentId },
				success: HttpApiSchema.NoContent,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Takes the right to use a Computer away from an Agent. The Computer stays.",
		),
		HttpApiEndpoint.get(
			"listComputerUsage",
			"/v1/computers/:computerId/usage",
			{
				params: computerParams,
				success: Schema.Array(ComputerUsage),
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Lists the times when a Computer ran, newest first. The provider bills them. OpenBot only records them.",
		),
		HttpApiEndpoint.post("pauseComputer", "/v1/computers/:computerId/pause", {
			params: computerParams,
			success: Computer,
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Pauses a Computer. The provider keeps its files. E2B also keeps its memory and running programs. Daytona starts it again from its files.",
		),
		HttpApiEndpoint.post("resumeComputer", "/v1/computers/:computerId/resume", {
			params: computerParams,
			success: Computer,
			error: ComputerErrors,
		}),
		HttpApiEndpoint.put(
			"setConnectorToken",
			"/v1/computers/:computerId/connector-token",
			{
				params: computerParams,
				success: ConnectorToken,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Makes a new token for the connector of a connector Computer. The old token stops working, and its connection closes.",
		),
		HttpApiEndpoint.post("runCommand", "/v1/computers/:computerId/commands", {
			params: computerParams,
			payload: RunCommandRequest,
			success: CommandResult,
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Runs a shell command and waits for it to end. A paused Computer resumes first.",
		),
		HttpApiEndpoint.get("readFile", "/v1/computers/:computerId/files", {
			params: computerParams,
			query: { path: Path, encoding: Schema.optionalKey(FileEncoding) },
			success: FileContent,
			error: ComputerErrors,
		}),
		HttpApiEndpoint.put("writeFile", "/v1/computers/:computerId/files", {
			params: computerParams,
			payload: FileContent,
			success: HttpApiSchema.NoContent,
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Writes a file. OpenBot makes the missing directories.",
		),
		HttpApiEndpoint.delete("removeFile", "/v1/computers/:computerId/files", {
			params: computerParams,
			query: { path: Path },
			success: HttpApiSchema.NoContent,
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Removes a file, or a directory with everything in it.",
		),
		HttpApiEndpoint.get("listFiles", "/v1/computers/:computerId/directory", {
			params: computerParams,
			query: { path: Path },
			success: Schema.Array(FileEntry),
			error: ComputerErrors,
		}),
		HttpApiEndpoint.put("openPort", "/v1/computers/:computerId/ports/:port", {
			params: {
				computerId: ComputerId,
				port: Schema.FiniteFromString.pipe(Schema.decodeTo(Port)),
			},
			success: OpenPort,
			error: ComputerErrors,
		}).annotate(OpenApi.Description, "Gives a port a public HTTPS address."),
		HttpApiEndpoint.post(
			"takeScreenshot",
			"/v1/computers/:computerId/desktop/screenshot",
			{ params: computerParams, success: Screenshot, error: ComputerErrors },
		),
		HttpApiEndpoint.post(
			"useDesktop",
			"/v1/computers/:computerId/desktop/actions",
			{
				params: computerParams,
				payload: Schema.Struct({
					actions: Schema.Array(DesktopAction).check(
						Schema.isMinLength(1),
						Schema.isMaxLength(50),
					),
				}),
				success: Screenshot,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Does the actions in order, then takes a screenshot.",
		),
		HttpApiEndpoint.post(
			"streamDesktop",
			"/v1/computers/:computerId/desktop/stream",
			{ params: computerParams, success: DesktopStream, error: ComputerErrors },
		).annotate(
			OpenApi.Description,
			"Gives an address where a person can watch and use the desktop.",
		),
		HttpApiEndpoint.get("getComputerPairing", "/v1/computer-pairings/:code", {
			params: { code: PairingCode },
			success: ComputerPairing,
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Shows which machine a pairing code is for, so the person can check it before they approve.",
		),
		HttpApiEndpoint.post(
			"approveComputerPairing",
			"/v1/computer-pairings/:code/approve",
			{
				params: { code: PairingCode },
				payload: ApprovePairingRequest,
				success: Computer.pipe(HttpApiSchema.status(201)),
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Approves a machine. OpenBot creates a connector Computer for it, and the machine gets its token on its next poll. The Computer belongs to the caller, or to the organization when `shared` is true. When the same machine pairs again, OpenBot keeps its Computer and only changes the token. Only a person can approve.",
		),
		HttpApiEndpoint.post(
			"denyComputerPairing",
			"/v1/computer-pairings/:code/deny",
			{
				params: { code: PairingCode },
				success: HttpApiSchema.NoContent,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Denies a machine. Its pairing ends at once.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key depends on the owner, which the path does not show.
	// So the handlers check the permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(AgentAuth) {}

const pairingErrors = [
	PairingInvalid.pipe(HttpApiSchema.status(404)),
	ComputersUnavailable.pipe(HttpApiSchema.status(503)),
] as const

/**
 * The calls of the connector on a machine. They need no API key.
 *
 * A machine gets its token in one of two ways:
 * - `openbot computer pair` starts a pairing and shows a code. A person approves the
 *   code with `POST /v1/computer-pairings/:code/approve`. The machine polls until it gets
 *   its token. This is the easy way for a machine where a person sits.
 * - A person creates a connector Computer and makes a token with
 *   `PUT /v1/computers/:computerId/connector-token`. This is the way for servers and scripts.
 *
 * Then the connector opens a WebSocket at `/v1/hooks/computers/connect` with
 * `Authorization: Bearer <token>`. Each text frame is one JSON message: `FromConnector`
 * from the connector and `ToConnector` from OpenBot. The connector sends `Hello` first.
 */
export class ComputerHooksApi extends HttpApiGroup.make("computerHooks").add(
	HttpApiEndpoint.post("startPairing", "/v1/hooks/computers/pairings", {
		payload: StartPairingRequest,
		success: Pairing.pipe(HttpApiSchema.status(201)),
		error: pairingErrors,
	}).annotate(
		OpenApi.Description,
		"Starts a pairing for a machine. The code works for 10 minutes.",
	),
	HttpApiEndpoint.post(
		"pollPairing",
		"/v1/hooks/computers/pairings/:pairingId/poll",
		{
			params: { pairingId: PairingId },
			headers: { authorization: Schema.String },
			success: PairingStatus,
			error: pairingErrors,
		},
	).annotate(
		OpenApi.Description,
		"Tells the machine if a person approved it. Send `Authorization: Bearer <secret>` with the secret of the pairing.",
	),
	HttpApiEndpoint.get("connectComputer", "/v1/hooks/computers/connect", {
		headers: { authorization: Schema.String },
		success: HttpApiSchema.NoContent,
		error: [
			ConnectorDenied.pipe(HttpApiSchema.status(401)),
			ComputersUnavailable.pipe(HttpApiSchema.status(503)),
		],
	}),
) {}
