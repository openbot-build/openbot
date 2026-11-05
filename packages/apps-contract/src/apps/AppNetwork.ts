import { Network } from "@openbot-build/protocol"
import { Context, Layer } from "effect"

export class AppNetwork extends Context.Service<
	AppNetwork,
	{
		readonly layer: (
			owner: string,
			origins: ReadonlyArray<string>,
		) => Layer.Layer<Network.Network>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
>()("@openbot-build/openbot/apps-contract/apps/AppNetwork") {}
