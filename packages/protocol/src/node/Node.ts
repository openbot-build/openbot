import { type LookupAllOptions, type LookupAddress } from "node:dns"
import { type AgentOptions } from "node:https"
import type * as Network from "../network/Network.ts"

/** A DNS resolver that returns every address, like node:dns lookup with `all: true`. */
export type Resolver = (
	hostname: string,
	options: LookupAllOptions,
	callback: (
		error: NodeJS.ErrnoException | null,
		addresses: Array<LookupAddress>,
	) => void,
) => void

export interface PublicOptions extends Network.Limits {
	/** The resolver that the real TLS socket lookup uses. The default is node:dns. */
	readonly lookup?: Resolver
	readonly ca?: AgentOptions["ca"]
	/**
	 * Must check each real address, including literal and redirected targets.
	 * The default for the public network is `isPublicAddress`.
	 */
	readonly allowAddress?: (address: string, hostname: string) => boolean
}

export interface UserOptions extends PublicOptions {
	readonly owner: string
	readonly allowedOrigins: ReadonlyArray<string>
	/** Must check each real address, including literal and redirected targets. */
	readonly allowAddress: (address: string, hostname: string) => boolean
}
