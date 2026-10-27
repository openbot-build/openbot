import { Execution } from "@openbot-build/domain"
import { errors as executionErrors } from "./ExecutionsApi.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotId } from "./BotsApi.ts"
import { BotAuth } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
} from "./Authorization.ts"
import {
	ApprovePairingRequest,
	Computer,
	ComputerAccess,
	ComputerConflict,
	ComputerExecutionFailed,
	ComputerId,
	ComputerInvalid,
	ComputerNotFound,
	ComputerNotReady,
	ComputerPairing,
	ComputerPathNotFound,
	ComputerProvider,
	ComputerProviderFailed,
	ComputerProviderId,
	ComputerProviderInUse,
	ComputerProviderNotFound,
	ComputerSessionNotFound,
	ComputerUnsupported,
	ComputerUsage,
	ComputersUnavailable,
	ConnectorDenied,
	ConnectorSessionId,
	ConnectorToken,
	CreateComputerProviderRequest,
	CreateComputerRequest,
	DesktopAction,
	DesktopStream,
	ExecRequest,
	FileContent,
	FileEncoding,
	FileEntry,
	OpenPort,
	Pairing,
	PairingCode,
	PairingId,
	PairingInvalid,
	PairingStatus,
	Path,
	Port,
	ResizeRequest,
	Screenshot,
	SessionOutput,
	StartPairingRequest,
	UpdateComputerProviderRequest,
	UpdateComputerRequest,
	WriteStdinRequest,
} from "@openbot-build/domain/Computers"
// Explicit names keep namespace exports in the generated declaration files.
export {
	ApprovePairingRequest,
	Computer,
	ComputerAccess,
	ComputerConflict,
	ComputerExecutionFailed,
	ComputerFeatures,
	ComputerId,
	ComputerInvalid,
	ComputerNotFound,
	ComputerNotReady,
	ComputerOwner,
	ComputerPairing,
	ComputerPathNotFound,
	ComputerProvider,
	ComputerProviderCredentials,
	ComputerProviderCredentialsView,
	ComputerProviderFailed,
	ComputerProviderId,
	ComputerProviderInUse,
	ComputerProviderKind,
	ComputerProviderNotFound,
	ComputerSessionNotFound,
	ComputerSource,
	ComputerState,
	ComputerUnsupported,
	ComputerUsage,
	ComputersUnavailable,
	ConnectorCall,
	ConnectorDenied,
	ConnectorHello,
	ConnectorReply,
	ConnectorSessionId,
	ConnectorToken,
	CreateComputerProviderRequest,
	CreateComputerRequest,
	DesktopAction,
	DesktopStream,
	ExecRequest,
	FileContent,
	FileEncoding,
	FileEntry,
	FromConnector,
	MaxOutputBytes,
	OpenPort,
	Pairing,
	PairingCode,
	PairingId,
	PairingInvalid,
	PairingStatus,
	Path,
	Port,
	ResizeRequest,
	Screenshot,
	SessionOutput,
	SessionSignal,
	StartPairingRequest,
	ToConnector,
	UpdateComputerProviderRequest,
	UpdateComputerRequest,
	WriteStdinRequest,
	YieldTime,
	connectorProtocolVersion,
	maxOutputBytesDefault,
	yieldTimeDefault,
} from "@openbot-build/domain/Computers"

export const ComputerErrors = [
	...AuthorizationErrors,
	ComputerNotFound.pipe(HttpApiSchema.status(404)),
	ComputerPathNotFound.pipe(HttpApiSchema.status(404)),
	ComputerProviderInUse.pipe(HttpApiSchema.status(409)),
	ComputerSessionNotFound.pipe(HttpApiSchema.status(404)),
	ComputerProviderNotFound.pipe(HttpApiSchema.status(404)),
	ComputerConflict.pipe(HttpApiSchema.status(409)),
	ComputerInvalid.pipe(HttpApiSchema.status(400)),
	ComputerUnsupported.pipe(HttpApiSchema.status(409)),
	ComputerNotReady.pipe(HttpApiSchema.status(409)),
	ComputerProviderFailed.pipe(HttpApiSchema.status(502)),
	ComputerExecutionFailed.pipe(HttpApiSchema.status(502)),
	ComputersUnavailable.pipe(HttpApiSchema.status(503)),
	PairingInvalid.pipe(HttpApiSchema.status(404)),
] as const

const providerParams = { providerId: ComputerProviderId }
export const ComputerCommand = Schema.Struct({
	commandKey: Execution.CommandKey,
})
export const CreateComputerCommand = Schema.Struct({
	...CreateComputerRequest.fields,
	...ComputerCommand.fields,
})

const computerParams = { computerId: ComputerId }
const sessionParams = { ...computerParams, sessionId: ConnectorSessionId }

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
	.middleware(BotAuth) {}

export class ComputersApi extends HttpApiGroup.make("computers")
	.add(
		HttpApiEndpoint.get("listComputers", "/v1/computers", {
			query: { bot: Schema.optionalKey(BotId) },
			success: Schema.Array(Computer),
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Computers that the caller can use: their own and the shared ones. With `bot`, it lists only the Computers that this Bot has the right to use.",
		),
		HttpApiEndpoint.post("createComputer", "/v1/computers", {
			payload: CreateComputerCommand,
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...ComputerErrors, ...executionErrors],
		}).annotate(
			OpenApi.Description,
			"Accepts a command to create a Computer and returns its execution receipt. Reuse the command key after a lost reply. A connector Computer stays offline until it connects.",
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
			payload: ComputerCommand,
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...ComputerErrors, ...executionErrors],
		}).annotate(
			OpenApi.Description,
			"Accepts a command to delete a Computer and its sandbox, files and Bot grants. Follow its execution receipt for the result. A lost provider reply waits for a decision.",
		),
		HttpApiEndpoint.get("listComputerBots", "/v1/computers/:computerId/bots", {
			params: computerParams,
			success: Schema.Array(ComputerAccess),
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Bots that have the right to use a Computer.",
		),
		HttpApiEndpoint.put(
			"grantComputer",
			"/v1/computers/:computerId/bots/:botId",
			{
				params: { computerId: ComputerId, botId: BotId },
				success: ComputerAccess,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Gives a Bot the right to use a Computer. The caller must be able to use the Computer and to change the Bot.",
		),
		HttpApiEndpoint.delete(
			"revokeComputer",
			"/v1/computers/:computerId/bots/:botId",
			{
				params: { computerId: ComputerId, botId: BotId },
				success: HttpApiSchema.NoContent,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Takes the right to use a Computer away from a Bot. The Computer stays.",
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
			payload: ComputerCommand,
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...ComputerErrors, ...executionErrors],
		}).annotate(
			OpenApi.Description,
			"Accepts a command to pause a Computer and returns its execution receipt. The provider keeps its files. E2B also keeps its memory and running programs.",
		),
		HttpApiEndpoint.post("resumeComputer", "/v1/computers/:computerId/resume", {
			params: computerParams,
			payload: ComputerCommand,
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...ComputerErrors, ...executionErrors],
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
		HttpApiEndpoint.post("exec", "/v1/computers/:computerId/sessions", {
			params: computerParams,
			payload: ExecRequest,
			success: SessionOutput,
			error: ComputerErrors,
		}).annotate(
			OpenApi.Description,
			"Starts a shell command and waits up to yieldTimeMs for it. When it still runs, the answer has a session ID for more input and output. A paused Computer resumes first.",
		),
		HttpApiEndpoint.post(
			"writeStdin",
			"/v1/computers/:computerId/sessions/:sessionId/input",
			{
				params: sessionParams,
				payload: WriteStdinRequest,
				success: SessionOutput,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Sends text to the stdin of a session, and gives the output since the last call.",
		),
		HttpApiEndpoint.post(
			"resizeSession",
			"/v1/computers/:computerId/sessions/:sessionId/resize",
			{
				params: sessionParams,
				payload: ResizeRequest,
				success: HttpApiSchema.NoContent,
				error: ComputerErrors,
			},
		),
		HttpApiEndpoint.delete(
			"closeSession",
			"/v1/computers/:computerId/sessions/:sessionId",
			{
				params: sessionParams,
				success: SessionOutput,
				error: ComputerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Stops the command of a session, and gives its last output.",
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
	.middleware(BotAuth) {}

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
