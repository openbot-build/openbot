/**
 * The services around the server of `Host`: the services from outside, the
 * tools of the host, and the shared services. This module is not public.
 */
import { Layer } from "effect"
import type { HttpClient } from "effect/http"
import type * as ErrorRecords from "../server-kernel/errors/Records.ts"
import * as HostTools from "../tools-contract/chats/HostTools.ts"
import type { AppOptions, Outside } from "./Host.ts"
import * as Outside_ from "./Outside.ts"
import * as Shared from "./Shared.ts"

/** The services from outside, the tools of the host, and the shared services. */
export const provide = <OE, OR>(options: AppOptions<OE, OR>) => {
	const outside: Layer.Layer<
		Outside,
		OE,
		OR | HttpClient.HttpClient | ErrorRecords.Records
	> = options.outside ?? Outside_.layer
	return <A, E, R>(app: Layer.Layer<A, E, R>) =>
		app.pipe(
			Layer.provide(Layer.merge(outside, options.hostTools ?? HostTools.none)),
			Layer.provideMerge(Shared.layer(options)),
		)
}
