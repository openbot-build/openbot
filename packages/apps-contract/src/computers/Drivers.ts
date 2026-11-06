import type { Computers as ComputerData } from "@openbot-build/domain"
import { Context, type Effect } from "effect"
import type { Provider } from "./Computer.ts"

/** Builds the driver of a Computer provider from its secrets. Tests give their own. */
export class Drivers extends Context.Service<
	Drivers,
	{
		readonly make: (
			credentials: ComputerData.ComputerProviderCredentials,
		) => Effect.Effect<Provider>
	}
>()("@openbot-build/apps-contract/computers/Drivers") {}
