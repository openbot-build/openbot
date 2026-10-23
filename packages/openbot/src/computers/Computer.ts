import type { ComputersApi } from "@openbot-build/api"
import { Data, type Effect } from "effect"

/** The provider or the connector did not do the call. */
export class ComputerCallFailed extends Data.TaggedError("ComputerCallFailed")<{
	readonly message: string
	/** False when trying again cannot help, such as a wrong key. */
	readonly retry: boolean
}> {}

/** The sandbox is gone at the provider, or the connector is not connected. */
export class ComputerGone extends Data.TaggedError("ComputerGone")<{
	readonly reason: string
}> {}

export type ComputerError = ComputerCallFailed | ComputerGone

/** What the provider says about a sandbox, in the form that every kind shares. */
export type MachineState = "starting" | "running" | "paused" | "gone"

/**
 * The work that every Computer can do: commands and files.
 * A paused sandbox resumes by itself on the first call, so callers do not check the state.
 */
export interface Shell {
	readonly run: (
		request: ComputersApi.RunCommandRequest,
	) => Effect.Effect<ComputersApi.CommandResult, ComputerError>
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
	readonly stream: Effect.Effect<ComputersApi.DesktopStream, ComputerError>
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
