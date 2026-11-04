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
>()("@openbot-build/openbot/apps-contract/apps/AppNetwork") {}
