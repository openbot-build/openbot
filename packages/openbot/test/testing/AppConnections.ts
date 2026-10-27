import { Client } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Effect, Scope } from "effect"
import { AppHost } from "../../src/apps/AppHost.ts"
import { ownerKey } from "../../src/apps/StoredConnections.ts"
import * as Probe from "../../src/apps/Probe.ts"
import type * as BrowserHost from "../BrowserHost.ts"

/** Opens a connection for one test member. Its client closes with the test scope. */
export const openClient = (
	host: BrowserHost.Host,
	member: { readonly userId: string; readonly organizationId: string },
	connectionId: string,
	name: string,
) =>
	Effect.flatMap(Effect.scope, (scope) =>
		host.run(
			Effect.gen(function* () {
				const app = (yield* AppHost).bind(
					ownerKey(member),
					Client.InvocationPolicy.of({ check: () => Effect.void }),
				)
				return yield* app.open({
					key: { owner: ownerKey(member), connectionId },
					clientInfo: { name, version: "1.0.0" },
				})
			}).pipe(Effect.provideService(Scope.Scope, scope)),
		),
	)

/** The test publisher runs on localhost with its own certificate. */
export const probeForLoopback = (ca: string) =>
	Probe.layerWithNetwork((connection) =>
		NodeHttpServer.layerUserNetwork({
			owner: connection.owner,
			allowedOrigins: [new URL(connection.endpoint).origin],
			ca,
			allowAddress: (ip) => ip === "127.0.0.1",
		}),
	)
