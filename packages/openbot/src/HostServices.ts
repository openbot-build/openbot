/**
 * The services around the server of `Host`: the services from outside, the
 * tools of the host, and the shared services. This module is not public.
 */
import { Layer } from "effect"
import type { HttpClient } from "effect/http"
import type * as ErrorRecords from "@openbot-build/server-kernel/Records"
import * as HostTools from "@openbot-build/tools-contract/HostTools"
import type { AppOptions, Outside } from "./Host.ts"
import * as Outside_ from "./Outside.ts"
import * as Shared from "./Shared.ts"

/**
 * The services from outside, the tools of the host, and the shared services.
 * The services from outside of the options take the place of the real ones.
 */
export const provide = <OE, OR, O extends Outside>(
	options: AppOptions<OE, OR, O>,
) => {
	const outside: Layer.Layer<
		Outside,
		OE,
		OR | HttpClient.HttpClient | ErrorRecords.Records
	> =
		options.outside === undefined
			? Outside_.layer
			: Layer.merge(Outside_.layer, options.outside)
	return <A, E, R>(app: Layer.Layer<A, E, R>) =>
		app.pipe(
			Layer.provide(Layer.merge(outside, options.hostTools ?? HostTools.none)),
			Layer.provideMerge(Shared.layer(options)),
		)
}
