import { type Config, type Redacted } from "effect"
import type * as OutboundPolicy from "../network/OutboundPolicy.ts"

/**
 * The configuration of one instance. Only values that belong to this instance
 * alone live here. Every value that all instances share lives in the database,
 * and the API changes it. The one exception is `secretKeys`: all instances need
 * the same keys, but the keys protect the database, so they cannot live in it.
 */
export interface Settings {
	readonly clusterSecret: Redacted.Redacted<string>
	readonly clusterHost?: string | undefined
	readonly host: string
	readonly port: number
	readonly databaseUrl: Redacted.Redacted<string>
	/** `OPENBOT_SECRET_KEYS`, such as `k2:<hex>,k1:<hex>`. The first key encrypts. */
	readonly secretKeys: Redacted.Redacted<string>
	/** `OPENBOT_OUTBOUND_ALLOW`: the private targets that outbound connections may reach. */
	readonly outboundAllow: OutboundPolicy.Allow
}
export type Load = Config.Config<Settings>
