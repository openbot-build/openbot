/**
 * The compositions of the App services. The static assembly and the apps
 * plugin both use them, so the two cannot drift.
 */
import {
	CatalogDiscovery,
	PublicIndexing,
	RobotsPolicy,
} from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import { IndexNamespace } from "../apps-contract/apps/IndexNamespace.ts"
import * as ActionPolicy from "./ActionPolicy.ts"
import * as AppHost from "./AppHost.ts"
import * as AuthorizationCommands from "./AuthorizationCommands.ts"
import * as Authorizations from "./Authorizations.ts"
import * as ConnectionCommands from "./ConnectionCommands.ts"
import * as Connections from "./Connections.ts"
import * as ConnectionSessions from "./ConnectionSessions.ts"
import * as GrantCleanup from "./GrantCleanup.ts"
import * as AppIndex from "./Index.ts"
import * as IndexStore from "./IndexStore.ts"
import * as IndexWork from "./IndexWork.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as ProtocolStores from "./ProtocolStores.ts"
import { IndexSources, IndexWorkOptions } from "./Wiring.ts"

/**
 * App connections and authorization. The workflows of Apps come later. It
 * needs `ConnectionScopes`, which the host gives.
 */
export const layerApps = Layer.mergeAll(
	Lifecycle.layer,
	Authorizations.layer,
).pipe(
	Layer.provideMerge(Connections.layer),
	Layer.provideMerge(ConnectionSessions.layer),
	Layer.provideMerge(AuthorizationCommands.layer),
	Layer.provideMerge(ConnectionCommands.layer),
	Layer.provideMerge(GrantCleanup.layer),
	Layer.provideMerge(AppHost.layer),
	Layer.provide(CatalogDiscovery.layerRules),
	Layer.provide(Layer.merge(ProtocolStores.layer, ActionPolicy.layer)),
)

/**
 * The App Index, the work that reads App Catalogs into it, and its store. It
 * reads its sources, its work options and its namespace from the references
 * of `Wiring.ts` and `IndexNamespace`.
 */
export const layerIndex = Layer.unwrap(
	Effect.gen(function* () {
		const sources = yield* IndexSources
		const options = yield* IndexWorkOptions
		const namespace = yield* IndexNamespace
		const indexing = PublicIndexing.layerInspection.pipe(
			Layer.provide(CatalogDiscovery.layerRules),
			Layer.provide(RobotsPolicy.layer),
		)
		const work = IndexWork.layer(options).pipe(Layer.provide(indexing))
		return Layer.merge(
			AppIndex.layer({
				simulated: namespace === "development",
				...(sources === undefined ? {} : { providers: sources }),
			}),
			work,
		).pipe(Layer.provideMerge(IndexStore.layer))
	}),
)
