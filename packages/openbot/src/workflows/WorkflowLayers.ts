import { Layer } from "effect"
import * as WorkflowPlugin from "../plugins/workflows/WorkflowPlugin.ts"
import * as Engine from "./Engine.ts"
import * as Execution from "./Execution.ts"
import * as Recordings from "./Recordings.ts"
import * as Runs from "./Runs.ts"
import * as Tasks from "./Tasks.ts"
import * as Worker from "./Worker.ts"
import * as Workflows from "./Workflows.ts"

/**
 * The Workflow services that Sessions use: the stores, the durable engine, the launcher
 * and the Workflow plugin. They need the Agent services.
 */
export const layerServices = WorkflowPlugin.layer.pipe(
	Layer.provideMerge(Execution.layer),
	Layer.provideMerge(
		Layer.mergeAll(Workflows.layer, Runs.layer, Recordings.layer),
	),
	Layer.provideMerge(Engine.layerEngine),
)

/** The work of Runs: the steps of the durable execution and the worker. They need the Session runtimes. */
export const layerWorkers = (options: Worker.Options = {}) =>
	Layer.merge(Worker.layer(options), Engine.layer).pipe(
		Layer.provideMerge(Tasks.layer),
	)
