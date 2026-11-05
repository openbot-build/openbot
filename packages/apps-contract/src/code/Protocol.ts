/** The messages between the host and the Code Mode worker. Every value crosses as JSON text. */

export interface Limits {
	/** Time inside QuickJS, in milliseconds. */
	readonly timeoutMs: number
	readonly memoryBytes: number
	/** The largest return value, and the most log text, in bytes. */
	readonly outputBytes: number
}

/** The answer to one App call. `value` and `error` are JSON text. */
export type Settled =
	| { readonly index: number; readonly ok: true; readonly value: string }
	| { readonly index: number; readonly ok: false; readonly error: string }

/**
 * A Vault item that the program can name. It has no values. The worker makes the
 * same references as `reference` in `../vaults/CodeMode.ts`.
 */
export interface VaultItem {
	readonly alias: string
	readonly fields: ReadonlyArray<string>
}

export type ToWorker =
	| {
			readonly type: "start"
			readonly code: string
			/** The names that the program can call, such as `calendar.list_events`. */
			readonly bindings: ReadonlyArray<string>
			readonly vault: ReadonlyArray<VaultItem>
			readonly seed: number
			readonly clock: number
			readonly limits: Limits
	  }
	| {
			readonly type: "results"
			/** The answers in the order of their index. */
			readonly results: ReadonlyArray<Settled>
	  }

export interface Call {
	readonly index: number
	readonly binding: string
	/** The arguments as JSON text of one object. */
	readonly arguments: string
}

export type FromWorker =
	/** The program waits for these calls. */
	| { readonly type: "calls"; readonly calls: ReadonlyArray<Call> }
	/** `value` is the JSON text of the return value. */
	| {
			readonly type: "done"
			readonly value: string
			readonly logs: ReadonlyArray<string>
	  }
	| {
			readonly type: "failed"
			readonly reason: "Error" | "Timeout" | "Memory" | "OutputTooLarge"
			readonly message: string
			readonly logs: ReadonlyArray<string>
	  }
