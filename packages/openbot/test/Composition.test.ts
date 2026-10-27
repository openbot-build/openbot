import type { Observation } from "../src/execution/Observation.ts"
import type { Store } from "../src/execution/Store.ts"
import type { Directory } from "../src/resources/Directory.ts"
import type { Access } from "../src/execution/Send.ts"
import type { Transport } from "../src/resources/Transport.ts"
import type { Records } from "../src/errors/Records.ts"
import type { Registry } from "../src/execution/Engine.ts"
import type { SqlClient } from "effect/sql"
import { assert, it } from "@effect/vitest"
import type { PgClient } from "@effect/sql-pg"
import {
	type Crypto,
	Effect,
	type Layer,
	Redacted,
	String as Str,
} from "effect"
import type { HttpClient } from "effect/http"
import * as OpenBot from "../src/app/OpenBot.ts"
import * as Server from "../src/app/Server.ts"
import type { HostTools } from "../src/chats/HostTools.ts"
import type { Secrets } from "../src/secrets/Secrets.ts"
import type { Settings } from "../src/settings/Settings.ts"

/** True when the two types are the same. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** The services that `OpenBot.layerShared` gives. */
type ExecutionServices =
	Access | Transport | Directory | Store | Observation | Registry

type Shared =
	PgClient.PgClient | SqlClient.SqlClient | Settings | Secrets | Records

/** The platform services, such as those of `NodeServices.layer` and `FetchHttpClient.layer`. */
type Platform = Crypto.Crypto | HttpClient.HttpClient

const options = {
	databaseUrl: Redacted.make("postgresql://unused"),
	clusterSecret: Redacted.make(
		"test-cluster-secret-with-at-least-32-characters",
	),
	secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
	host: "127.0.0.1",
	port: 0,
}

it.effect(
	"OpenBot asks for the outside, execution, shared and platform services",
	() =>
		Effect.sync(() => {
			const app = OpenBot.layer(options)
			const needs: Same<
				Layer.Services<typeof app>,
				OpenBot.Outside | Shared | Platform | ExecutionServices
			> = true
			const live = OpenBot.layerLive(options)
			const liveNeeds: Same<
				Layer.Services<typeof live>,
				Shared | Platform | ExecutionServices
			> = true
			const outside = OpenBot.layerOutside
			const outsideGives: Same<
				Layer.Success<typeof outside>,
				OpenBot.Outside
			> = true
			const outsideNeeds: Same<
				Layer.Services<typeof outside>,
				HttpClient.HttpClient | Records
			> = true
			assert.deepStrictEqual(
				[needs, liveNeeds, outsideGives, outsideNeeds],
				[true, true, true, true],
			)
		}),
)

it.effect(
	"the live server needs only the platform services that the entry points give",
	() =>
		Effect.sync(() => {
			const server = Server.layerLive(options)
			const needs: Same<
				Layer.Services<typeof server>,
				Crypto.Crypto | HttpClient.HttpClient
			> = true
			const custom = Server.layer(options)
			// The server of `layer` gets the shared services and the services from outside from its caller.
			const customNeeds: Same<
				Exclude<
					Layer.Services<typeof custom>,
					| OpenBot.Outside
					| HostTools
					| Shared
					| HttpClient.HttpClient
					| Crypto.Crypto
					| SqlClient.SqlClient
				>,
				never
			> = true
			assert.deepStrictEqual([needs, customNeeds], [true, true])
		}),
)
