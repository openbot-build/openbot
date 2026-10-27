import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import { assert, describe, it } from "@effect/vitest"
import { ModelProvidersApi } from "@openbot-build/api"
import { Config, Live, Model, Provider } from "@openbot-build/core"
import { Cause, Effect, Layer, Logger, Redacted, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { Billing } from "../src/billing/Billing.ts"
import { TokenThrottle } from "../src/billing/TokenThrottle.ts"
import * as LiveBackends from "../src/models/LiveBackends.ts"
import {
	ModelProviders,
	organizationOwner,
	type Stored,
} from "../src/models/ModelProviders.ts"
import * as ModelRegistry from "../src/models/ModelRegistry.ts"
import { Models, type StoredModel } from "../src/models/Models.ts"
import { organizationDefaults } from "../src/settings/Documents.ts"
import { Settings } from "../src/settings/Settings.ts"
import { codec, snapshot } from "../src/errors/Snapshot.ts"

const organizationId = "org_a"

const provider: Stored = {
	id: "prov_live",
	owner: organizationOwner(organizationId),
	kind: "openai",
	name: "Live provider",
	endpoint: null,
	apiKey: "sealed",
	apiKeyHint: null,
	models: [
		{
			model: Model.Id.make("talk"),
			modelOwner: "organization",
			upstream: "talk-1",
		},
	],
	availability: null,
	version: 1,
	createdAt: 1,
	updatedAt: 1,
}

const talk: StoredModel = {
	owner: organizationOwner(organizationId),
	id: "talk",
	type: "live",
	name: "Talk",
	reasoningEfforts: [],
	serviceTiers: [],
	contextWindow: null,
	maxOutputTokens: null,
	availability: null,
	version: 1,
	createdAt: 1,
	updatedAt: 1,
}

const selection = Config.Selection.make({
	provider: Provider.Id.make("prov_live"),
	model: Model.Id.make("talk"),
})

/**
 * A registry over one provider with one Live model, without a database. The
 * fakes have only the methods that a Live model needs.
 */
const registryWith = (input: {
	readonly openKey: (typeof ModelProviders.Service)["openKey"]
	readonly backend: LiveBackends.LiveBackend["make"]
	readonly providers?: Effect.Effect<ReadonlyArray<Stored>>
	readonly models?: ReadonlyArray<StoredModel>
}) =>
	Layer.effect(ModelRegistry.ModelRegistry, ModelRegistry.make()).pipe(
		Layer.provide([
			ErrorRecordsFixture.layer,
			Layer.mock(ModelProviders, {
				available: () => input.providers ?? Effect.succeed([provider]),
				openKey: input.openKey,
			}),
			Layer.mock(Models, {
				available: () => Effect.succeed(input.models ?? [talk]),
			}),
			Layer.mock(Settings, {
				organization: () =>
					Effect.succeed({
						document: organizationDefaults,
						version: 1,
						updatedAt: 1,
					}),
				changes: Stream.empty,
			}),
			LiveBackends.layer([{ kind: "openai", make: input.backend }]),
			// A Live model is metered only when a Live Turn runs.
			Layer.mock(Billing, {}),
			Layer.mock(TokenThrottle, {}),
			Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make(() => Effect.die("The tests send no requests.")),
			),
		]),
	)

const resolveLive = Effect.flatMap(ModelRegistry.ModelRegistry, (registry) =>
	registry.resolveLive(organizationId, selection),
)

const key = () => Effect.succeed(Redacted.make("key"))

describe("The model registry", () => {
	it.effect(
		"says that a Live model is unavailable when its backend fails, and a bad option only when the backend does not support it",
		() =>
			Effect.gen(function* () {
				for (const [reason, expected] of [
					["connect", "unavailable"],
					["provider", "unavailable"],
					["unsupported", "unsupported-option"],
				] as const) {
					const failed = yield* resolveLive.pipe(
						Effect.flip,
						Effect.provide(
							registryWith({
								openKey: key,
								backend: () =>
									Effect.fail(
										Live.LiveError.make({
											reason,
											message: "private-live-key",
										}),
									),
							}),
						),
					)
					assert.ok(Schema.is(Config.ModelConfigurationError)(failed))
					assert.strictEqual(failed.reason, expected)
					assert.strictEqual(
						failed.message,
						reason === "unsupported"
							? "The provider does not support this Live model."
							: "OpenBot cannot start the Live model right now.",
					)
					assert.notMatch(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Config.ModelConfigurationError),
						)(failed),
						/private-/,
					)
					assert.include(
						yield* Cause.fail(failed).pipe(
							snapshot,
							Schema.encodeEffect(codec),
						),
						"private-live-key",
					)
				}
			}),
	)

	it.effect(
		"keeps a private key failure and tells the caller only that it is unavailable",
		() => {
			let lines: ReadonlyArray<{
				readonly level: string
				readonly message: unknown
				readonly cause: Cause.Cause<unknown>
			}> = []
			const logger = Logger.layer([
				Logger.make((log) => {
					lines = [
						...lines,
						{ level: log.logLevel, message: log.message, cause: log.cause },
					]
				}),
			])
			return Effect.gen(function* () {
				const failed = yield* resolveLive.pipe(Effect.flip)
				assert.ok(Schema.is(Config.ModelConfigurationError)(failed))
				assert.strictEqual(failed.reason, "unavailable")
				// The public fields have no inside failure. A sealed record can still keep it.
				assert.strictEqual(
					failed.message,
					"OpenBot cannot open the provider key right now.",
				)
				assert.deepStrictEqual(lines, [])
				assert.include(
					yield* Cause.fail(failed).pipe(snapshot, Schema.encodeEffect(codec)),
					"ModelProvidersUnavailable",
				)
			}).pipe(
				Effect.provide(
					Layer.merge(
						registryWith({
							openKey: () =>
								Effect.fail(
									ModelProvidersApi.ModelProvidersUnavailable.make({}),
								),
							backend: () => Effect.die("The backend must not run."),
						}),
						logger,
					),
				),
			)
		},
	)

	it.effect(
		"builds a model once, builds it again after a failed build, and builds it again when the provider changes",
		() => {
			let opened = 0
			let version = 1
			const typesafe = (): Stored => ({
				...provider,
				id: "prov_ts",
				kind: "typesafe",
				endpoint: "https://decisions.example.com/v1",
				models: [
					{
						model: Model.Id.make("jev"),
						modelOwner: "organization",
						upstream: "jev-latest",
					},
				],
				version,
			})
			const jev: StoredModel = {
				...talk,
				id: "jev",
				type: "decision",
				name: "Jev",
			}
			return Effect.gen(function* () {
				const registry = yield* ModelRegistry.ModelRegistry
				const decide = registry.decision(
					organizationId,
					Config.Selection.make({
						provider: Provider.Id.make("prov_ts"),
						model: Model.Id.make("jev"),
					}),
				)
				// The first build cannot open the key. The registry does not keep the failure.
				const failed = yield* Effect.flip(decide)
				assert.strictEqual(failed.reason, "unavailable")
				// Each lookup adds its own organization meter around the cached model.
				yield* decide
				yield* decide
				assert.strictEqual(opened, 2)
				// A changed provider has a new version, so it gets a new model.
				version = 2
				yield* decide
				assert.strictEqual(opened, 3)
			}).pipe(
				Effect.provide(
					registryWith({
						providers: Effect.sync(() => [typesafe()]),
						models: [jev],
						openKey: () =>
							Effect.suspend(() => {
								opened++
								return opened === 1
									? Effect.fail(
											ModelProvidersApi.ModelProvidersUnavailable.make({}),
										)
									: Effect.succeed(Redacted.make("key"))
							}),
						backend: () => Effect.die("The backend must not run."),
					}),
				),
			)
		},
	)
})
