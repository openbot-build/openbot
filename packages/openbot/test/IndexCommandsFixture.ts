import { Indexing } from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import * as Work from "../src/plugin-apps/IndexWork.ts"
import * as Store from "@openbot-build/server-execution/execution/Store"
import * as Governance from "../src/plugin-apps/Governance.ts"
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
