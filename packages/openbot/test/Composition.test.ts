import type { Records } from "@openbot-build/server-kernel/Records"
import { assert, it } from "@effect/vitest"
import { Plugin as GraftPlugin } from "@graftland/graft"
import { Effect, Layer, Redacted, String as Str } from "effect"
import type { Digest, SecureRandom } from "effect/crypto"
import type { HttpClient } from "effect/http"
import type * as Assembly from "../src/Assembly.ts"
import * as Host from "../src/Host.ts"
import type * as Launch from "../src/Launch.ts"
import * as Outside from "../src/Outside.ts"
import type * as Preset from "../src/Preset.ts"
import type * as Feature from "@openbot-build/server-plugin/Feature"
import type { Wallets } from "../src/Wallets.ts"

/** True when the two types are the same. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * The members of `A` that are the same type as a member of `B`. It compares
 * whole types, because the type of one service can extend another.
 */
type Overlap<A, B> = A extends unknown
	? true extends (B extends unknown ? Same<A, B> : never)
		? A
		: never
	: never

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
				Host.Outside
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

/** Every service that a plugin of the preset publishes. */
type Published = {
	readonly [Id in Preset.Id]: Feature.ServicesOf<
		(typeof Preset.plugins)[Id]["plugin"]
	>
}[Preset.Id]

it.effect(
	"the plugins publish no service of the kernel, and the host gives no service of a plugin",
	() =>
		Effect.sync(() => {
			const apart: Same<Overlap<Published, Assembly.Kernel>, never> = true
			// Routes and startup work inject every service of a plugin that they need.
			const routes: Same<
				Overlap<Host.RouteServices, Published | Wallets>,
				never
			> = true
			const startup: Same<
				Overlap<Host.StartupServices, Published | Wallets>,
				never
			> = true
			const app = Host.layerApp(options)
			const server = Host.layer(options)
			const noPlugin: Same<
				Overlap<
					Layer.Success<typeof app> | Layer.Success<typeof server>,
					Published | Wallets
				>,
				never
			> = true
			assert.deepStrictEqual(
				[apart, routes, startup, noPlugin],
				[true, true, true, true],
			)
		}),
)

it.effect("only routes and startup make the work of the host", () =>
	Effect.sync(() => {
		const plugin = GraftPlugin.make({
			name: "outside",
			apply: () => Effect.void,
		})
		// @ts-expect-error A plain object with a plugin is not work of the host.
		const forged: Host.Work = { plugin }
		const made: Host.Work = Host.startup({
			name: "test",
			inject: [],
			layer: Layer.empty,
		})
		assert.deepStrictEqual([typeof made, typeof forged], ["object", "object"])
	}),
)
