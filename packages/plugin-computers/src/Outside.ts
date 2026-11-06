import { Drivers } from "@openbot-build/apps-contract/computers/Drivers"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import * as DaytonaProvider from "./DaytonaProvider.ts"
import * as E2bProvider from "./E2bProvider.ts"
import { Records } from "@openbot-build/server-kernel/Records"

/** The real drivers of the Computer providers. They use the network of the process. */
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
