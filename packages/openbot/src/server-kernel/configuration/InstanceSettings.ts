import { Context, type Option, type Redacted } from "effect"

/**
 * The settings of this instance that a plugin reads when it starts. The host
 * gives them. They do not change while the process runs.
 */
export interface Service {
	/** The address of the Postgres database. Better Auth opens its own pool with it. */
	readonly databaseUrl: Redacted.Redacted<string>
	/**
	 * Use the local test account instead of a sign-in provider. The public
	 * origin and the sign-in secret still come from the platform settings.
	 */
	readonly development: boolean
	/**
	 * The path of the plugins file (`OPENBOT_PLUGINS_FILE`). The host reads it
	 * one time, when it starts.
	 */
	readonly pluginsFile: Option.Option<string>
}

export class InstanceSettings extends Context.Service<
	InstanceSettings,
	Service
>()("@openbot-build/openbot/server-kernel/configuration/InstanceSettings") {}
