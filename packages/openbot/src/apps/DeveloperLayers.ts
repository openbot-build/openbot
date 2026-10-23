import { Layer } from "effect"
import {
	CatalogDiscovery,
	PublicIndexing,
	RobotsPolicy,
	type Network,
} from "@openbot-build/protocol"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"
import * as AppInspections from "./AppInspections.ts"
import * as Access from "./DeveloperAccess.ts"
import * as Members from "./DeveloperMembers.ts"
import * as Reports from "./DeveloperReports.ts"
import * as DomainControl from "./DomainControl.ts"
import * as Tests from "./DeveloperTests.ts"
import * as Indexing from "./DeveloperIndexing.ts"
import * as Notifications from "./DeveloperNotifications.ts"
import * as Monitor from "./DeveloperMonitor.ts"
import * as TestRuntime from "./DeveloperTestRuntime.ts"
import * as TestStores from "./DeveloperTestStores.ts"
import { AppConnections } from "@openbot-build/protocol"
import { NodeCrypto } from "@effect/platform-node"
import { AppNetwork, layerNetwork } from "./AppHost.ts"

export const layer = (
	options: {
		readonly publicNetwork?: Layer.Layer<Network.PublicNetwork>
		readonly domainControl?: Layer.Layer<DomainControl.DomainControl>
		readonly publicOrigin?: string
		readonly appNetwork?: Layer.Layer<AppNetwork>
	} = {},
) => {
	const publicOrigin = options.publicOrigin ?? "https://localhost"
	const publicNetwork =
		options.publicNetwork ?? OutboundPolicy.layerPublicNetwork
	const inspections = AppInspections.layer.pipe(
		Layer.provide(
			PublicIndexing.layerInspection.pipe(
				Layer.provide(CatalogDiscovery.layerRules),
				Layer.provide(RobotsPolicy.layer),
				Layer.provide(publicNetwork),
			),
		),
	)
	const access = Access.layer.pipe(
		Layer.provide(options.domainControl ?? DomainControl.layer),
		Layer.provide(RobotsPolicy.layer),
		Layer.provide(publicNetwork),
		Layer.provideMerge(inspections),
	)
	const testRuntime = TestRuntime.layer(publicOrigin).pipe(
		Layer.provideMerge(TestStores.layer),
		Layer.provide(NodeCrypto.layer),
		Layer.provide(AppConnections.layerConnectionScopes.pipe(Layer.fresh)),
		Layer.provide(options.appNetwork ?? layerNetwork),
	)
	const tests = Tests.layer(publicOrigin).pipe(
		Layer.provide(testRuntime),
		Layer.provide(CatalogDiscovery.layerRules),
	)
	const monitoring = Monitor.layerWorker.pipe(Layer.provideMerge(Monitor.layer))
	return Layer.mergeAll(
		Members.layer,
		Reports.layer,
		Indexing.layer,
		Notifications.layer,
		monitoring,
		Tests.layerWorker,
	).pipe(Layer.provideMerge(tests), Layer.provideMerge(access))
}
