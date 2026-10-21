import { Network } from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import * as Fence from "./ExecutionFence.ts"
import { accountId } from "./OwnedWrites.ts"

const blocked = () =>
	new Network.NetworkError({
		reason: "BlockedTarget",
		message: "The account cannot send requests from this runtime.",
	})
/** Each private connection keeps its send lease until its request Scope closes. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const layer = (
	owner: string,
	transport: Layer.Layer<Network.Network>,
): Layer.Layer<Network.Network> =>
	Layer.effect(
		Network.Network,
		Effect.map(Network.Network, (network) =>
			Network.Network.of({
				...network,
				execute: (request) =>
					Fence.guardScoped(
						accountId(owner),
						"send",
						network.execute(request),
					).pipe(
						Effect.mapError((error) =>
							error instanceof Fence.FenceUnavailable ? blocked() : error,
						),
					),
				readDocument: (input) =>
					Fence.guard(
						accountId(owner),
						"send",
						network.readDocument(input),
					).pipe(
						Effect.mapError((error) =>
							error instanceof Fence.FenceUnavailable ? blocked() : error,
						),
					),
			}),
		),
	).pipe(Layer.provide(transport))
