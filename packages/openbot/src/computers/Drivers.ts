import type { Computers as ComputerData } from "@openbot-build/domain"
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import type { Provider } from "./Computer.ts"
import * as DaytonaProvider from "./daytona/DaytonaProvider.ts"
import * as E2bProvider from "./e2b/E2bProvider.ts"
import { Records } from "../errors/Records.ts"

/** Builds the driver of a Computer provider from its secrets. Tests give their own. */
export class Drivers extends Context.Service<
	Drivers,
	{
		readonly make: (
			credentials: ComputerData.ComputerProviderCredentials,
		) => Effect.Effect<Provider>
	}
>()("@openbot-build/openbot/computers/Drivers") {}

export const layer = Layer.effect(
	Drivers,
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const records = yield* Records
		return Drivers.of({
			make: (credentials) => {
				switch (credentials.kind) {
					case "e2b":
						return E2bProvider.make(credentials).pipe(
							Effect.provideService(HttpClient.HttpClient, client),
							Effect.provideService(Records, records),
						)
					case "daytona":
						return DaytonaProvider.make(credentials).pipe(
							Effect.provideService(HttpClient.HttpClient, client),
							Effect.provideService(Records, records),
						)
				}
			},
		})
	}),
)
