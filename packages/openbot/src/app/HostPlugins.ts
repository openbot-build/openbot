import { AuthApi, FailureApi } from "@openbot-build/api"
import { type Graft, Plugin as GraftPlugin } from "@graftland/graft"
import { Loader, type Tree } from "@graftland/loader"
import { Effect, Layer } from "effect"
import { Commands } from "@openbot-build/server-execution/execution/Commands"
import * as ExecutionHandlers from "@openbot-build/server-execution/execution/HttpHandlers"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { HttpHost } from "@openbot-build/server-kernel/errors/HttpHost"
import * as Feature from "@openbot-build/server-plugin/Feature"

/**
 * The routes of executions. The host owns them, so nobody can turn them off.
 * The engine, not a plugin, owns executions.
 */
export const executions = Feature.make("openbot/executions").start({
	inject: [
		HttpHost,
		Commands,
		Records,
		AuthApi.BotAuth,
		FailureApi.FailureBoundary,
	],
	layer: Layer.effectDiscard(
		Effect.flatMap(HttpHost, (host) =>
			host.mount(["executions"], ExecutionHandlers.layer),
		),
	),
})

/**
 * Runs the loader on these entries and publishes the `Loader` service. The
 * loader and its forks belong to this fork, so they close with it.
 */
export const loader = (
	store: Loader.Store,
): GraftPlugin.Plugin<
	void,
	void,
	Tree.InvalidOperation | Graft.ServiceConflict
> =>
	GraftPlugin.make({
		name: "openbot/loader",
		apply: () => Loader.start(store),
	})
