import { NodeRuntime } from "@effect/platform-node"
import * as Development from "./Development.ts"

// `Development.launch` logs a failed start with its annotations. The default
// report of runMain would log the same failure again.
NodeRuntime.runMain(Development.launch, { disableErrorReporting: true })
