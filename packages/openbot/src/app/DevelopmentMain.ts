import { NodeRuntime } from "@effect/platform-node"
import * as Development from "./Development.ts"

NodeRuntime.runMain(Development.launch)
