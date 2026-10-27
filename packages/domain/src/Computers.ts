import { Array as Arr, Schema, Struct } from "effect"
import * as Execution from "./Execution.ts"
import { SecretOutput } from "./Secret.ts"
import { BotId } from "./BotId.ts"
import { PublicOrigin, SecretInput, SecretState, Version } from "./Settings.ts"

/** A hidden Computer has the same result as a missing Computer. */
export class ComputerNotFound extends Schema.TaggedError<
	ComputerNotFound,
	{ readonly brand: unique symbol }
>()("ComputerNotFound", { id: Schema.String }) {}

/** The full cause stays inside the server. */
export class StorageError extends Schema.TaggedError<
	StorageError,
	{ readonly brand: unique symbol }
>()("ComputerStorageError", { cause: Schema.Defect() }) {}

export type Need = "read" | "use" | "write"

export const ComputerId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ComputerId"))
export type ComputerId = typeof ComputerId.Type

export const ComputerProviderId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ComputerProviderId"))
export type ComputerProviderId = typeof ComputerProviderId.Type

/**
 * A member owns their own Computers and Computer providers. Only they and their
 * Bots can use them. The organization owns shared ones. Policies decide who can use them.
 */
export const ComputerOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
})
export type ComputerOwner = typeof ComputerOwner.Type

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

/**
 * The service that runs Computers.
 * `e2b` is any service that speaks the E2B API, such as E2B, PPIO, Alibaba Cloud Bot
 * Sandbox, or a self-hosted E2B. `daytona` is Daytona, hosted or self-hosted.
 * It comes from `ComputerProviderCredentials`.
 */
export const ComputerProviderKind = Schema.Literals(
	Arr.map(
		ComputerProviderCredentials.members,
		(member) => member.fields.kind.literal,
	),
)
export type ComputerProviderKind = typeof ComputerProviderKind.Type

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
 * A machine where Bots run commands, change files and use a desktop.
 * A member or the organization owns it. Bots never own a Computer. They get the
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
	/** The member that made the Computer, or the Bot that made it for its member. */
	createdBy: Schema.String,
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
	lastActiveAt: Schema.NullOr(Schema.Finite),
	/** A saved maintenance action that must end before new work can start. */
	executionId: Schema.optionalKey(Execution.Id),
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
 * The right of one Bot to use one Computer. Many Bots can use one Computer.
 * Only the Bot with the right can use it. Its child Bots ask for their own right.
 * The right ends when the Bot is archived. The Computer stays.
 */
export const ComputerAccess = Schema.Struct({
	computer: ComputerId,
	bot: BotId,
	/** The member who gave the right, or who answered the request of the Bot. */
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
export const ConnectorToken = Schema.Struct({ token: SecretOutput })
export type ConnectorToken = typeof ConnectorToken.Type

export const Path = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4096),
)

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

export const Port = Schema.Int.check(
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
		Failed: {
			message: Schema.String,
			reason: Schema.Literals(["NotFound", "Failed"]),
		},
	}),
})
export type ConnectorReply = typeof ConnectorReply.Type

/** The version of the connector protocol in this contract. */
export const connectorProtocolVersion = 3

/** The first message of a connector. It tells OpenBot what the machine can do. */
export const ConnectorHello = Schema.Struct({
	/**
	 * The version of the protocol that the connector speaks. OpenBot does not take a
	 * connector with a version lower than `connectorProtocolVersion`.
	 */
	version: Schema.Int,
	os: Schema.String,
	arch: Schema.String,
	desktop: Schema.Boolean,
})
export type ConnectorHello = typeof ConnectorHello.Type

/** The ID that OpenBot gives to a command session on a connector. */
export const ConnectorSessionId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ConnectorSessionId"))
export type ConnectorSessionId = typeof ConnectorSessionId.Type

/** The size of a terminal, in rows or columns of letters. */
const TerminalSize = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(1000),
)

/** Base64 bytes of the input or the output of a command. */
const SessionBytes = Schema.String

/** A signal that OpenBot can send to the processes of a session. */
export const SessionSignal = Schema.Literals([
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGHUP",
	"SIGQUIT",
])
export type SessionSignal = typeof SessionSignal.Type

/**
 * A message from OpenBot to a connector. Each WebSocket text frame holds one message as JSON.
 * OpenBot sends `Ping` every 20 seconds. The connector answers with `Pong`.
 *
 * `Start` runs a command in a new session. The command runs with `bash -lc` in its own
 * process group. With `tty`, it gets a terminal (a PTY), and stdout and stderr come
 * together on that terminal. Without `tty`, stdin is a pipe, and stdout and stderr
 * come together in one stream. The connector stops all its sessions when the
 * connection closes.
 */
export const ToConnector = Schema.TaggedUnion({
	Call: { call: ConnectorCall },
	Ping: {},
	Start: {
		session: ConnectorSessionId,
		/** A shell command. It runs with `bash -lc`. */
		command: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(100_000),
		),
		cwd: Schema.optionalKey(Path),
		env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
		tty: Schema.Boolean,
		/** The size of the terminal. It is only for `tty`. The default is 24 rows and 80 columns. */
		rows: Schema.optionalKey(TerminalSize),
		cols: Schema.optionalKey(TerminalSize),
	},
	/**
	 * Bytes for stdin. Without `tty`, the byte `0x04` (Ctrl-D) closes stdin, as it does at
	 * the start of a line on a terminal. The connector does not send that byte.
	 */
	Input: { session: ConnectorSessionId, data: SessionBytes },
	/** Gives the terminal a new size. It does nothing without `tty`. */
	Resize: {
		session: ConnectorSessionId,
		rows: TerminalSize,
		cols: TerminalSize,
	},
	/** Sends a signal to all the processes of the session. */
	Signal: { session: ConnectorSessionId, signal: SessionSignal },
	/** Stops all the processes of the session. The connector then sends `Exit`. */
	Close: { session: ConnectorSessionId },
})
export type ToConnector = typeof ToConnector.Type

/**
 * A message from a connector to OpenBot. The first message must be `Hello`.
 *
 * `Output` gives new output of a session as soon as it comes. `seq` starts at 0 and
 * goes up by 1 with each `Output` of the session. `Exit` is the last message of a
 * session. It comes after all its `Output`.
 */
export const FromConnector = Schema.TaggedUnion({
	Hello: { hello: ConnectorHello },
	Reply: { reply: ConnectorReply },
	Pong: {},
	Output: {
		session: ConnectorSessionId,
		seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		data: SessionBytes,
	},
	Exit: {
		session: ConnectorSessionId,
		/** `null` when a signal stopped the command, or when it did not start. */
		code: Schema.NullOr(Schema.Int),
		/** The name of the signal that stopped the command, such as `SIGINT`. */
		signal: Schema.NullOr(Schema.String),
		/** Why the command did not start, such as a folder that does not exist. */
		error: Schema.optionalKey(Schema.String),
	},
})
export type FromConnector = typeof FromConnector.Type

/** How long a call waits for output before it gives back what it has, in milliseconds. */
export const YieldTime = Schema.Int.check(
	Schema.isBetween({ minimum: 250, maximum: 30_000 }),
)
/** Ten seconds. */
export const yieldTimeDefault = 10_000
/** The most output that one call gives back, in bytes. */
export const MaxOutputBytes = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 }),
)
export const maxOutputBytesDefault = 64 * 1024

export const ExecRequest = Schema.Struct({
	/** A shell command. It runs with `bash -lc`. */
	command: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(100_000),
	),
	cwd: Schema.optionalKey(Path),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/**
	 * Give the command a terminal (a PTY), for programs that need one, such as a
	 * Python prompt or ssh. Then stdout and stderr come together.
	 */
	tty: Schema.optionalKey(Schema.Boolean),
	rows: Schema.optionalKey(TerminalSize),
	cols: Schema.optionalKey(TerminalSize),
	yieldTimeMs: Schema.optionalKey(YieldTime),
	maxOutputBytes: Schema.optionalKey(MaxOutputBytes),
})
export type ExecRequest = typeof ExecRequest.Type

export const WriteStdinRequest = Schema.Struct({
	/** Text for stdin. It may be empty, to only read new output. */
	chars: Schema.String.check(Schema.isMaxLength(100_000)),
	yieldTimeMs: Schema.optionalKey(YieldTime),
	maxOutputBytes: Schema.optionalKey(MaxOutputBytes),
})
export type WriteStdinRequest = typeof WriteStdinRequest.Type

export const ResizeRequest = Schema.Struct({
	rows: TerminalSize,
	cols: TerminalSize,
})
export type ResizeRequest = typeof ResizeRequest.Type

/** What a command session gave since the last call. */
export const SessionOutput = Schema.Struct({
	/** Give it to the next call. It is `null` when the command has ended. */
	session: Schema.NullOr(ConnectorSessionId),
	running: Schema.Boolean,
	/** `null` while the command runs, or when a signal stopped it. */
	exitCode: Schema.NullOr(Schema.Int),
	signal: Schema.NullOr(Schema.String),
	/** The new output, as UTF-8 text. */
	output: Schema.String,
	/** True when there was more new output than `maxOutputBytes`. Then only its end is here. */
	truncated: Schema.Boolean,
})
export type SessionOutput = typeof SessionOutput.Type

export const PairingId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/PairingId"))
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
	secret: SecretOutput,
	interval: Schema.Int,
	expiresAt: Schema.Finite,
})
export type Pairing = typeof Pairing.Type

/** `Approved` comes only once. Then the machine keeps the token and connects with it. */
export const PairingStatus = Schema.TaggedUnion({
	Pending: {},
	Approved: { computer: ComputerId, token: SecretOutput },
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

export class ComputerProviderNotFound extends Schema.TaggedError<
	ComputerProviderNotFound,
	{ readonly brand: unique symbol }
>()("ComputerProviderNotFound", { id: Schema.String }) {}
/** A file or folder is not there. */
export class ComputerPathNotFound extends Schema.TaggedError<
	ComputerPathNotFound,
	{ readonly brand: unique symbol }
>()("ComputerPathNotFound", { path: Schema.String }) {}
/** Computers still use this provider. */
export class ComputerProviderInUse extends Schema.TaggedError<
	ComputerProviderInUse,
	{ readonly brand: unique symbol }
>()("ComputerProviderInUse", { id: Schema.String }) {}
export class ComputerConflict extends Schema.TaggedError<
	ComputerConflict,
	{ readonly brand: unique symbol }
>()("ComputerConflict", {
	version: Version,
	/** Observe this execution before trying another Computer action. */
	executionId: Schema.optionalKey(Execution.Id),
}) {}
export class ComputerInvalid extends Schema.TaggedError<
	ComputerInvalid,
	{ readonly brand: unique symbol }
>()("ComputerInvalid", { message: Schema.String }) {}
/** The Computer cannot do this, such as a desktop action on a Computer without a desktop. */
export class ComputerUnsupported extends Schema.TaggedError<
	ComputerUnsupported,
	{ readonly brand: unique symbol }
>()("ComputerUnsupported", {
	feature: Schema.Literals([...Struct.keys(ComputerFeatures.fields), "stream"]),
}) {}
/** The Computer is offline or failed. */
export class ComputerNotReady extends Schema.TaggedError<
	ComputerNotReady,
	{ readonly brand: unique symbol }
>()("ComputerNotReady", { state: ComputerState }) {}
/** The provider refused the call or did not answer. */
export class ComputerProviderFailed extends Schema.TaggedError<
	ComputerProviderFailed,
	{ readonly brand: unique symbol }
>()("ComputerProviderFailed", { message: Schema.String }) {}
export class ComputersUnavailable extends Schema.TaggedError<
	ComputersUnavailable,
	{ readonly brand: unique symbol }
>()("ComputersUnavailable", {}) {}
/** The token is wrong, or the Computer is not a connector Computer. */
export class ConnectorDenied extends Schema.TaggedError<
	ConnectorDenied,
	{ readonly brand: unique symbol }
>()("ConnectorDenied", {}) {}
/** The pairing is unknown, denied, used or too old. Run `openbot computer pair` again. */
export class PairingInvalid extends Schema.TaggedError<
	PairingInvalid,
	{ readonly brand: unique symbol }
>()("PairingInvalid", {}) {}

/** The session is not there. It ended long ago, or it belongs to another Chat. */
/** The error ID links to the private cause. Unknown writes must not be sent again. */
export class ComputerExecutionFailed extends Schema.TaggedError<
	ComputerExecutionFailed,
	{ readonly brand: unique symbol }
>()("ComputerExecutionFailed", { failure: Execution.Failure }) {}

export class ComputerSessionNotFound extends Schema.TaggedError<
	ComputerSessionNotFound,
	{ readonly brand: unique symbol }
>()("ComputerSessionNotFound", { id: ConnectorSessionId }) {}
