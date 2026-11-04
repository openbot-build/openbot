import * as Assembly from "./Assembly.ts"
import type * as Host from "./Host.ts"
import { provide } from "./HostServices.ts"
import * as Launch from "./Launch.ts"

// The program uses no service of a plugin, so it serves the app without the
// snapshot of `Host.layer`. Then the plugins file can turn plugins off.
Launch.main((options: Host.Options) =>
	provide(options)(Assembly.layerProgram(options)),
)
