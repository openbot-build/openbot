import * as TestCleanup from "./TestCleanup.ts"
import * as TestCommands from "./TestCommands.ts"
import { Layer } from "effect"
import {
	CatalogDiscovery,
	PublicIndexing,
	RobotsPolicy,
} from "@openbot-build/protocol"
import * as AppInspections from "./AppInspections.ts"
import * as ProofCommands from "./ProofCommands.ts"
import * as Access from "./DeveloperAccess.ts"
import * as Members from "./DeveloperMembers.ts"
import * as Reports from "./DeveloperReports.ts"
import * as Tests from "./DeveloperTests.ts"
import * as Indexing from "./DeveloperIndexing.ts"
import * as Notifications from "./DeveloperNotifications.ts"
import * as Watches from "./DeveloperWatches.ts"
import * as Monitor from "./DeveloperMonitor.ts"
import * as TestRuntime from "./DeveloperTestRuntime.ts"
import * as TestStores from "./DeveloperTestStores.ts"
import * as ConnectionScopes from "../resources/ConnectionScopes.ts"

/**
 * The services of the developer center. They use the public network, the DNS
 * check of domains and the network of Apps that the host gives.
 */
export const services = Layer.mergeAll(
	Members.layer,
	ProofCommands.layer,
	Reports.layer,
	Indexing.layer,
	Notifications.layer,
	Monitor.layer,
).pipe(
	Layer.provideMerge(
		Tests.layer.pipe(
			Layer.provideMerge(
				Layer.mergeAll(TestCommands.layer, TestCleanup.layer).pipe(
					Layer.provideMerge(TestStores.layer),
				),
			),
			Layer.provideMerge(
				TestRuntime.layer.pipe(Layer.provideMerge(TestStores.layer)),
			),
			Layer.provide(CatalogDiscovery.layerRules),
		),
	),
	Layer.provideMerge(
		Access.layer.pipe(
			Layer.provide(RobotsPolicy.layer),
			Layer.provideMerge(
				AppInspections.layer.pipe(
					Layer.provide(
						PublicIndexing.layerInspection.pipe(
							Layer.provide(CatalogDiscovery.layerRules),
							Layer.provide(RobotsPolicy.layer),
						),
					),
				),
			),
		),
	),
	Layer.provideMerge(Watches.layer),
)

export const layer = services.pipe(
	Layer.provide(ConnectionScopes.layerDeveloper),
)
