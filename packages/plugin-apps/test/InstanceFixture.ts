import { Layer, Option, Redacted } from "effect"
import { InstanceSettings } from "@openbot-build/server-kernel/InstanceSettings"

/**
 * A public instance, so the App rows use the public namespace. The App
 * services read only `development`; they never open the database URL.
 */
export const layer = Layer.succeed(InstanceSettings, {
	databaseUrl: Redacted.make("postgres://unused"),
	development: false,
	pluginsFile: Option.none(),
})
