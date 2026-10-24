// Each test owns the Layers that it provides at the point where it runs.
// @effect-diagnostics strictEffectProvide:off

import { assert, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { Decision, DecisionModel } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Config } from "@openbot-build/core"
import * as ModelRegistry from "../src/models/ModelRegistry.ts"
import {
	ModelProviders,
	organizationOwner,
	type Stored,
} from "../src/models/ModelProviders.ts"
import { Models, type StoredModel } from "../src/models/Models.ts"
import * as TypeSafeProvider from "../src/providers/typesafe/TypeSafeProvider.ts"
import { organizationDefaults } from "../src/settings/Documents.ts"
import { Settings } from "../src/settings/Settings.ts"

interface Sent {
	readonly url: string
	readonly authorization: string | undefined
	readonly body: {
		readonly model: string
		readonly state: unknown
		readonly questions: Record<string, { readonly type: string }>
	}
}

/** An HTTP client that keeps each request and answers like TypeSafe. */
const fakeTypeSafe = () => {
	const sent: Array<Sent> = []
	const layer = Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) => {
			if (request.body._tag === "Uint8Array")
				sent.push({
					url: request.url,
					authorization: request.headers["authorization"],
					body: JSON.parse(new TextDecoder().decode(request.body.body)),
				})
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					globalThis.Response.json({
						model: "jev-1.13.0",
						answers: {
							route: {
								type: "choice",
								choice: "billing",
								probabilities: { billing: 0.8, technical: 0.2 },
								confidence: 0.9,
							},
						},
						usage: { input_tokens: 12, output_tokens: 0 },
					}),
				),
			)
		}),
	)
	return { sent, layer }
}

const Triage = Decision.make({
	input: Schema.String,
	decisions: {
		route: Decision.classify({
			instructions: "Which team should handle this message?",
			criteria: { billing: "Payments", technical: "Bugs" },
		}),
	},
})

it.effect(
	"a typesafe decision model sends its key, address and upstream model, and gives checked answers",
	() =>
		Effect.gen(function* () {
			const http = fakeTypeSafe()
			const answer = yield* DecisionModel.decide(Triage, {
				input: "I paid two times.",
			}).pipe(
				Effect.provide(
					TypeSafeProvider.layer({
						apiKey: Redacted.make("ts-key-0123"),
						apiUrl: "https://decisions.example.com/v1",
						upstreamModel: "jev-latest",
					}).pipe(Layer.provide(http.layer)),
				),
			)
			assert.strictEqual(answer.answers.route.label, "billing")
			assert.strictEqual(answer.answers.route.probabilities.technical, 0.2)
			assert.strictEqual(answer.usage.inputTokens, 12)
			assert.strictEqual(http.sent.length, 1)
			const [request] = http.sent
			assert.strictEqual(
				request?.url,
				"https://decisions.example.com/v1/systemone",
			)
			assert.strictEqual(request?.authorization, "Bearer ts-key-0123")
			assert.strictEqual(request?.body.model, "jev-latest")
			assert.strictEqual(request?.body.state, "I paid two times.")
			assert.strictEqual(request?.body.questions["route"]?.type, "choice")
		}),
)

const organizationId = "org_a"

const provider = (input: {
	readonly id: string
	readonly kind: Stored["kind"]
	readonly version?: number
}): Stored => ({
	id: input.id,
	owner: organizationOwner(organizationId),
	kind: input.kind,
	name: input.id,
	endpoint: "https://decisions.example.com/v1/",
	apiKey: "sealed",
	apiKeyHint: null,
	models: [
		{ model: "jev", modelOwner: "organization", upstream: "jev-latest" },
	],
	availability: null,
	version: input.version ?? 1,
	createdAt: 1,
	updatedAt: 1,
})

const jev: StoredModel = {
	owner: organizationOwner(organizationId),
	id: "jev",
	type: "decision",
	name: "Jev",
	reasoningEfforts: [],
	serviceTiers: [],
	contextWindow: null,
	maxOutputTokens: null,
	availability: null,
	version: 1,
	createdAt: 1,
	updatedAt: 1,
}

/** A registry over fixed providers and settings, without a database. */
const registryWith = (input: {
	readonly providers: ReadonlyArray<Stored>
	readonly http: Layer.Layer<HttpClient.HttpClient>
}) =>
	Layer.effect(ModelRegistry.ModelRegistry, ModelRegistry.make()).pipe(
		Layer.provide([
			Layer.succeed(ModelProviders, {
				list: () => Effect.die("unused"),
				get: () => Effect.die("unused"),
				available: () => Effect.succeed(input.providers),
				create: () => Effect.die("unused"),
				update: () => Effect.die("unused"),
				delete: () => Effect.die("unused"),
				openKey: () => Effect.succeed(Redacted.make("ts-key-0123")),
			}),
			Layer.succeed(Models, {
				list: () => Effect.die("unused"),
				get: () => Effect.die("unused"),
				available: () => Effect.succeed([jev]),
				create: () => Effect.die("unused"),
				update: () => Effect.die("unused"),
				delete: () => Effect.die("unused"),
			}),
			Layer.succeed(Settings, {
				platform: Effect.die("unused"),
				organization: () =>
					Effect.succeed({
						document: organizationDefaults,
						version: 1,
						updatedAt: 1,
					}),
				initializePlatform: () => Effect.die("unused"),
				updatePlatform: () => Effect.die("unused"),
				replacePlatform: () => Effect.die("unused"),
				updateOrganization: () => Effect.die("unused"),
				member: () => Effect.die("unused"),
				updateMember: () => Effect.die("unused"),
				notify: () => Effect.die("unused"),
				changes: Stream.empty,
			}),
			input.http,
		]),
	)

const selection = (providerId: string) =>
	Config.Selection.make({
		provider: providerId as Config.Selection["provider"],
		model: "jev" as Config.Selection["model"],
	})

it.effect("the registry builds the decision model that a selection names", () =>
	Effect.gen(function* () {
		const http = fakeTypeSafe()
		const label = yield* Effect.gen(function* () {
			const registry = yield* ModelRegistry.ModelRegistry
			const model = yield* registry.decision(
				organizationId,
				selection("prov_ts"),
			)
			const again = yield* registry.decision(
				organizationId,
				selection("prov_ts"),
			)
			// The registry builds each decision model once.
			assert.strictEqual(again, model)
			const answer = yield* DecisionModel.decide(Triage, {
				input: "I paid two times.",
			}).pipe(Effect.provideService(DecisionModel.DecisionModel, model))
			return answer.answers.route.label
		}).pipe(
			Effect.provide(
				registryWith({
					providers: [provider({ id: "prov_ts", kind: "typesafe" })],
					http: http.layer,
				}),
			),
		)
		assert.strictEqual(label, "billing")
		assert.strictEqual(
			http.sent[0]?.url,
			"https://decisions.example.com/v1/systemone",
		)
		assert.strictEqual(http.sent[0]?.body.model, "jev-latest")
	}),
)

it.effect(
	"the registry gives an error when no provider offers the decision model, or cannot ask it",
	() =>
		Effect.gen(function* () {
			for (const [providers, message] of [
				[[], /No provider of the organization offers/],
				[
					[provider({ id: "prov_ts", kind: "openai-compat" })],
					/openai-compat provider yet/,
				],
			] as const) {
				const failed = yield* Effect.flatMap(
					ModelRegistry.ModelRegistry,
					(registry) => registry.decision(organizationId, selection("prov_ts")),
				).pipe(
					Effect.flip,
					Effect.provide(
						registryWith({
							providers,
							http: fakeTypeSafe().layer,
						}),
					),
				)
				assert.ok(failed instanceof Config.ModelConfigurationError)
				assert.match(failed.message, message)
			}
		}),
)
