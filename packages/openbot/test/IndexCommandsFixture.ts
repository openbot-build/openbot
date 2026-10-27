import { Indexing } from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import * as Work from "../src/apps/IndexWork.ts"
import * as Store from "../src/execution/Store.ts"
import * as Governance from "../src/apps/Governance.ts"
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
