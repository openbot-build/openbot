import { AuthApi, FailureApi } from "@openbot-build/api"
import { type Graft, Plugin as GraftPlugin } from "@graftland/graft"
import { Loader, type Tree } from "@graftland/loader"
import { Effect, Layer, type Scope } from "effect"
import { Commands } from "../server-execution/execution/Commands.ts"
import * as ExecutionHandlers from "../server-execution/execution/HttpHandlers.ts"
import { Records } from "../server-kernel/errors/Records.ts"
import { HttpHost } from "../server-kernel/errors/HttpHost.ts"
import * as Feature from "../server-plugin/Feature.ts"

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
export const loader = (store: Loader.Store) =>
	GraftPlugin.make({
		name: "openbot/loader",
		apply: () => startLoader(store),
	})

/**
 * The published types of `Loader.start` in @graftland/loader 0.3.2
 * are `Effect<void, unknown, unknown>`: the build of the package lost the
 * types of its source. The source needs only graft and a scope. It fails only
 * when the entries are not valid or when its key is published already.
 */
const startLoader = Loader.start as (
	store: Loader.Store,
) => Effect.Effect<
	void,
	Tree.InvalidOperation | Graft.ServiceConflict,
	Graft.Graft | Scope.Scope
>
