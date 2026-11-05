import { Indexing } from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import * as Work from "@openbot-build/plugin-apps/IndexWork"
import * as Store from "@openbot-build/server-execution/execution/Store"
import * as Governance from "@openbot-build/plugin-apps/Governance"
import * as OrganizationFixture from "./OrganizationFixture.ts"

/** Storage tests submit work without starting the execution engine. */
export const layer = Work.layer().pipe(
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
