import type { Records } from "../src/server-kernel/errors/Records.ts"
import type { SqlClient } from "effect/sql"
import { assert, it } from "@effect/vitest"
import type { NodeServices } from "@effect/platform-node"
import { Effect, type Layer, Redacted, String as Str } from "effect"
import type { Digest, SecureRandom } from "effect/crypto"
import type { Etag, HttpClient, HttpPlatform, HttpRouter } from "effect/http"
import type * as Assembly from "../src/app/Assembly.ts"
import * as Host from "../src/app/Host.ts"
import type * as Launch from "../src/app/Launch.ts"
import * as Outside from "../src/app/Outside.ts"
import type * as Preset from "../src/app/Preset.ts"
import type * as Shared from "../src/app/Shared.ts"
import type * as Authentication from "../src/plugin-auth/HttpMiddleware.ts"
import type * as Authorization from "../src/plugin-authorization/Layer.ts"
import type { Wallets } from "../src/server-billing/billing/Host.ts"
import type { HostTools } from "../src/tools-contract/chats/HostTools.ts"
import type { Settings } from "../src/server-kernel/settings/Settings.ts"
import type { PgClient } from "@effect/sql-pg"

/** True when the two types are the same. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

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
	"the server needs only the platform services that the entry points give",
	() =>
		Effect.sync(() => {
			const server = Host.layer(options)
			const needs: Same<Layer.Services<typeof server>, Platform> = true
			const launched: [Layer.Services<typeof server>] extends [Launch.Platform]
				? true
				: false = true
			const outside = Outside.layer
			const outsideGives: Same<
				Layer.Success<typeof outside>,
				Outside.Services
			> = true
			const outsideNeeds: Same<
				Layer.Services<typeof outside>,
				HttpClient.HttpClient | Records
			> = true
			assert.deepStrictEqual(
				[needs, launched, outsideGives, outsideNeeds],
				[true, true, true, true],
			)
		}),
)

it.effect(
	"the private server gets the shared and outside services from its caller",
	() =>
		Effect.sync(() => {
			const customNeeds: Same<
				Exclude<
					Layer.Services<ReturnType<typeof Assembly.layerServer>>,
					| Outside.Services
					| HostTools
					| Shared.Services
					| Platform
					| SqlClient.SqlClient
				>,
				never
			> = true
			assert.isTrue(customNeeds)
		}),
)

it.effect("the public options take no changed list of plugins", () =>
	Effect.sync(() => {
		const entries: "entries" extends keyof Host.Options ? false : true = true
		const plugins: "plugins" extends keyof Host.Options ? false : true = true
		const appEntries: "entries" extends keyof Host.AppOptions ? false : true =
			true
		assert.deepStrictEqual([entries, plugins, appEntries], [true, true, true])
	}),
)

/** The services that more routes could use before the plugin host. */
type OldRouteServices =
	| HttpRouter.HttpRouter
	| NodeServices.NodeServices
	| Etag.Generator
	| HttpPlatform.HttpPlatform
	| PgClient.PgClient
	| Settings
	| Wallets
	| Layer.Services<
			| typeof Authentication.layerBotAuth
			| typeof Authentication.layerNoStore
			| typeof Authorization.layer
	  >

/** The services of the router and of the platform. The host does not give them. */
type Serving =
	| HttpRouter.HttpRouter
	| NodeServices.NodeServices
	| Etag.Generator
	| HttpPlatform.HttpPlatform

it.effect(
	"the plugins publish no service of the kernel, and the routes get every service that they may use",
	() =>
		Effect.sync(() => {
			const apart: [Extract<Preset.Published, Assembly.Kernel>] extends [never]
				? true
				: false = true
			const old: Same<OldRouteServices, Host.RouteServices> = true
			const given: Same<
				Exclude<
					Exclude<Host.RouteServices, Serving>,
					Preset.Published | Assembly.Kernel
				>,
				never
			> = true
			// The entry points give a snapshot of the published services, so their callers keep them.
			const app = Host.layerApp(options)
			const snapshot: [Preset.Published] extends [Layer.Success<typeof app>]
				? true
				: false = true
			assert.deepStrictEqual(
				[apart, old, given, snapshot],
				[true, true, true, true],
			)
		}),
)
