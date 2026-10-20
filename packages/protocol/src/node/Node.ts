import { type LookupAllOptions, type LookupAddress } from "node:dns"
import { type AgentOptions } from "node:https"
import type * as Network from "../network/Network.ts"

export interface PublicOptions extends Network.Limits {
	/** The resolver that the real TLS socket lookup uses. The default is node:dns. */
	readonly lookup?: (
		hostname: string,
		options: LookupAllOptions,
		callback: (
			error: NodeJS.ErrnoException | null,
			addresses: Array<LookupAddress>,
		) => void,
	) => void
	readonly ca?: AgentOptions["ca"]
}

export interface UserOptions extends PublicOptions {
	readonly owner: string
	readonly allowedOrigins: ReadonlyArray<string>
	/** Must check each real address, including literal and redirected targets. */
	readonly allowAddress: (address: string, hostname: string) => boolean
}
