import { Indexing } from "@openbot-build/protocol"
import { Effect, Layer, Option, Redacted } from "effect"
import { InstanceSettings } from "@openbot-build/server-kernel/InstanceSettings"
import * as Work from "@openbot-build/plugin-apps/IndexWork"
import * as Store from "@openbot-build/server-execution/Store"
import * as Governance from "@openbot-build/plugin-apps/Governance"
import * as OrganizationFixture from "./OrganizationFixture.ts"

/**
 * A public instance, so the App rows use the public namespace. The App
 * services read only `development`; they never open the database URL.
 */
export const layerPublicInstance = Layer.succeed(InstanceSettings, {
	databaseUrl: Redacted.make("postgres://unused"),
	development: false,
	pluginsFile: Option.none(),
})

/** Storage tests submit work without starting the execution engine. */
export const layer = Work.layer().pipe(
	Layer.provide(layerPublicInstance),
	Layer.provide(
		Layer.succeed(Indexing.PublicationInspection, {
			inspect: () => Effect.die("The storage test must not send a check."),
		}),
	),
	Layer.provide(Store.layer),
	Layer.provide(
		Governance.layer.pipe(
			Layer.provide(OrganizationFixture.layerDefaultSettings),
		),
	),
)
