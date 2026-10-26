import type { ComputersApi } from "@openbot-build/api"
import { Data, type Effect, Schema, type Scope, type Stream } from "effect"

/** The provider or the connector did not do the call. */
export class ComputerCallFailed extends Schema.TaggedError<
	ComputerCallFailed,
	{ readonly brand: unique symbol }
>()("ComputerCallFailed", {
	message: Schema.String,
	/** False when trying again cannot help, such as a wrong key. */
	retry: Schema.Boolean,
	/** The path of a file or folder that is not there. */
	missingPath: Schema.optionalKey(Schema.String),
	/** The inside failure, such as a refused connection. It is for the log only. */
	cause: Schema.optional(Schema.Defect()),
}) {}

/** The sandbox is gone at the provider, or the connector is not connected. */
export class ComputerGone extends Schema.TaggedError<
	ComputerGone,
	{ readonly brand: unique symbol }
>()("ComputerGone", {
	message: Schema.String,
}) {}

export type ComputerError = ComputerCallFailed | ComputerGone

/** What the provider says about a sandbox, in the form that every kind shares. */
export type MachineState = "starting" | "running" | "paused" | "gone"

/** A command that a provider runs to its end for its own work, such as a desktop script. */
export interface RunRequest {
	readonly command: string
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
	/** Seconds. The provider stops the command after this time. The default is 60. */
	readonly timeout?: number
}
export interface RunResult {
	/** `null` when the provider stopped the command at its timeout. */
	readonly exitCode: number | null
	readonly stdout: string
	readonly stderr: string
}

/** A command to start. It runs with `bash -lc` in its own process group. */
export interface StartRequest {
	readonly command: string
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
	/** Give the command a terminal (a PTY). Then stdout and stderr come together. */
	readonly tty: boolean
	readonly rows?: number
	readonly cols?: number
}

/** How a command ended. */
export interface Exit {
	/** `null` when a signal stopped it, or when it did not start. */
	readonly code: number | null
	readonly signal: string | null
	/** Why the command did not start, or why its stream broke. */
	readonly error?: string
}

/** A command that runs. Closing its Scope stops it. */
export interface Process {
	/** The output as it comes: stdout and stderr together. It ends when the command ends. */
	readonly output: Stream.Stream<Uint8Array>
	readonly exit: Effect.Effect<Exit>
	readonly write: (data: Uint8Array) => Effect.Effect<void, ComputerError>
	readonly resize: (
		rows: number,
		cols: number,
	) => Effect.Effect<void, ComputerError>
	readonly signal: (
		signal: ComputersApi.SessionSignal,
	) => Effect.Effect<void, ComputerError>
}

/**
 * The work that every Computer can do: commands and files.
 * A paused sandbox resumes by itself on the first call, so callers do not check the state.
 */
export interface Shell {
	/** Starts a command. It stops when the Scope closes. */
	readonly start: (
		request: StartRequest,
	) => Effect.Effect<Process, ComputerError, Scope.Scope>
	readonly read: (
		path: string,
		encoding: ComputersApi.FileEncoding,
	) => Effect.Effect<ComputersApi.FileContent, ComputerError>
	readonly write: (
		file: ComputersApi.FileContent,
	) => Effect.Effect<void, ComputerError>
	readonly list: (
		path: string,
	) => Effect.Effect<ReadonlyArray<ComputersApi.FileEntry>, ComputerError>
	readonly remove: (path: string) => Effect.Effect<void, ComputerError>
}

/** A Computer that can pause. The provider keeps its files. E2B also keeps its memory and programs. */
export interface Pausable {
	readonly pause: Effect.Effect<void, ComputerError>
	readonly resume: Effect.Effect<void, ComputerError>
}

/** A Computer with a desktop. Coordinates are pixels of the last screenshot. */
export interface Desktop {
	readonly screenshot: Effect.Effect<ComputersApi.Screenshot, ComputerError>
	readonly act: (
		actions: ReadonlyArray<ComputersApi.DesktopAction>,
	) => Effect.Effect<void, ComputerError>
	/** A live view of the desktop. It is there only when the Computer can give one. */
	readonly stream?: Effect.Effect<ComputersApi.DesktopStream, ComputerError>
}

/** A Computer that can give a port a public HTTPS address. */
export interface Ports {
	readonly open: (port: number) => Effect.Effect<string, ComputerError>
}

/**
 * One running Computer. Each feature is there only when the Computer has it,
 * so a caller cannot call a feature that the Computer does not have.
 */
export class Machine extends Data.TaggedClass("Computer.Machine")<{
	readonly shell: Shell
	readonly pausable?: Pausable
	readonly desktop?: Desktop
	readonly ports?: Ports
	readonly state: Effect.Effect<MachineState, ComputerCallFailed>
	/** Deletes the sandbox at the provider. It does nothing when the sandbox is already gone. */
	readonly destroy: Effect.Effect<void, ComputerCallFailed>
}> {}

/** What OpenBot asks a provider for when it creates a Computer. */
export interface Spec {
	/** A template or image of the provider. Without it, the provider uses its default. */
	readonly template?: string
	readonly desktop: boolean
	/** The labels that the provider shows next to the sandbox, such as the Computer ID. */
	readonly labels: Readonly<Record<string, string>>
}

/**
 * The integration of one Computer provider. Each kind has its own folder, like the
 * Channels and the model providers. A Provider value holds the key of one stored
 * Computer provider.
 */
export class Provider extends Data.TaggedClass("Computer.Provider")<{
	readonly kind: ComputersApi.ComputerProviderKind
	/** Checks the key with the provider. */
	readonly verify: Effect.Effect<void, ComputerCallFailed>
	/** Makes a sandbox. `ref` is its ID at the provider. OpenBot stores it with the Computer. */
	readonly create: (
		spec: Spec,
	) => Effect.Effect<{ readonly ref: string }, ComputerCallFailed>
	/** Gets the sandbox with this ref, so OpenBot can work with it. */
	readonly attach: (ref: string) => Effect.Effect<Machine, ComputerError>
}> {}
