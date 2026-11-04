import type { Observation } from "../src/server-execution/execution/Observation.ts"
import type { Store } from "../src/server-execution/execution/Store.ts"
import type { Directory } from "../src/server-execution/resources/Directory.ts"
import type { Access } from "../src/server-execution/execution/Send.ts"
import type { Transport } from "../src/server-execution/resources/Transport.ts"
import type { Records } from "../src/server-kernel/errors/Records.ts"
import type { Workflows } from "../src/server-execution/execution/Workflows.ts"
import type { SqlClient } from "effect/sql"
import { assert, it } from "@effect/vitest"
import type { PgClient } from "@effect/sql-pg"
import { Effect, type Layer, Redacted, String as Str } from "effect"
import type { Digest, SecureRandom } from "effect/crypto"
import type { HttpClient } from "effect/http"
import * as BillingHost from "../src/app/BillingHost.ts"
import * as ExecutionLayers from "../src/app/ExecutionLayers.ts"
import type * as Host from "../src/app/Host.ts"
import * as OpenBot from "../src/app/OpenBot.ts"
import type * as Preset from "../src/app/Preset.ts"
import * as Server from "../src/app/Server.ts"
import type { HostTools } from "../src/tools-contract/chats/HostTools.ts"
import type { Secrets } from "../src/server-kernel/secrets/Secrets.ts"
import type { Settings } from "../src/server-kernel/settings/Settings.ts"

/** True when the two types are the same. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** The services that `OpenBot.layerShared` gives. */
type ExecutionServices =
	Access | Transport | Directory | Store | Observation | Workflows

type Shared =
	PgClient.PgClient | SqlClient.SqlClient | Settings | Secrets | Records

/**
 * The platform services, such as those of `NodeCrypto.layer` and
 * `FetchHttpClient.layer`.
 */
type Platform =
	SecureRandom.SecureRandom | Digest.Digest | HttpClient.HttpClient

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
			const needs: Same<Layer.Services<typeof server>, Platform> = true
			const custom = Server.layer(options)
			// The server of `layer` gets the shared services and the services from outside from its caller.
			const customNeeds: Same<
				Exclude<
					Layer.Services<typeof custom>,
					OpenBot.Outside | HostTools | Shared | Platform | SqlClient.SqlClient
				>,
				never
			> = true
			assert.deepStrictEqual([needs, customNeeds], [true, true])
		}),
)

/** The services of the static assembly that the kernel does not give. */
type StaticServices = Exclude<
	| Layer.Success<ReturnType<typeof OpenBot.layer>>
	| Layer.Success<typeof ExecutionLayers.layer>
	| Layer.Success<typeof BillingHost.layer>,
	Host.Kernel
>

it.effect(
	"the plugins publish every service of the static assembly, and no service of the kernel",
	() =>
		Effect.sync(() => {
			const covered: [StaticServices] extends [Preset.Published]
				? true
				: false = true
			const apart: [Extract<Preset.Published, Host.Kernel>] extends [never]
				? true
				: false = true
			// The wrappers give a snapshot of the published services, so their callers keep them.
			const exposed = Server.layerApp(options)
			const wrappers: [StaticServices] extends [Layer.Success<typeof exposed>]
				? true
				: false = true
			assert.deepStrictEqual([covered, apart, wrappers], [true, true, true])
		}),
)
