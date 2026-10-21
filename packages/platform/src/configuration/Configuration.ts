import { type Config, type Redacted } from "effect"
import { type Configuration as Authentication } from "../auth/Model.ts"
import type * as Organization from "../organization/Organization.ts"

export interface Settings {
	readonly host: string
	readonly port: number
	readonly databaseUrl: Redacted.Redacted<string>
	readonly appEncryptionKey: Redacted.Redacted<string>
	readonly auth: Authentication
	/** Who becomes a Super Administrator, and the first allowed email domains. */
	readonly organization?: Organization.Options | undefined
	/** PEM file paths for serving HTTPS directly, usually during local development. */
	readonly tls?:
		{ readonly certFile: string; readonly keyFile: string } | undefined
}
export type Load = Config.Config<Settings>
