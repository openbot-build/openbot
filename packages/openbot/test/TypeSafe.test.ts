// Each test owns the Layers that it provides at the point where it runs.
// @effect-diagnostics strictEffectProvide:off

import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
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

test("a typesafe decision model sends its key, address and upstream model, and gives checked answers", async () => {
	const http = fakeTypeSafe()
	const answer = await Effect.runPromise(
		DecisionModel.decide(Triage, { input: "I paid two times." }).pipe(
			Effect.provide(
				TypeSafeProvider.layer({
					apiKey: Redacted.make("ts-key-0123"),
					apiUrl: "https://decisions.example.com/v1",
					upstreamModel: "jev-latest",
				}).pipe(Layer.provide(http.layer)),
			),
		),
	)
	assert.equal(answer.answers.route.label, "billing")
	assert.equal(answer.answers.route.probabilities.technical, 0.2)
	assert.equal(answer.usage.inputTokens, 12)
	assert.equal(http.sent.length, 1)
	const [request] = http.sent
	assert.equal(request?.url, "https://decisions.example.com/v1/systemone")
	assert.equal(request?.authorization, "Bearer ts-key-0123")
	assert.equal(request?.body.model, "jev-latest")
	assert.equal(request?.body.state, "I paid two times.")
	assert.equal(request?.body.questions["route"]?.type, "choice")
})

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
	readonly decisionModel: Config.Selection | null
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
						document: {
							...organizationDefaults,
							decisionModel: input.decisionModel,
						},
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

test("the registry builds the decision model that the organization settings name", async () => {
	const http = fakeTypeSafe()
	const label = await Effect.runPromise(
		Effect.gen(function* () {
			const registry = yield* ModelRegistry.ModelRegistry
			const model = yield* registry.decision(organizationId)
			assert.ok(Option.isSome(model))
			const again = yield* registry.decision(organizationId)
			// The registry builds each decision model once.
			assert.equal(Option.getOrThrow(again), model.value)
			const answer = yield* DecisionModel.decide(Triage, {
				input: "I paid two times.",
			}).pipe(Effect.provideService(DecisionModel.DecisionModel, model.value))
			return answer.answers.route.label
		}).pipe(
			Effect.provide(
				registryWith({
					providers: [provider({ id: "prov_ts", kind: "typesafe" })],
					decisionModel: selection("prov_ts"),
					http: http.layer,
				}),
			),
		),
	)
	assert.equal(label, "billing")
	assert.equal(http.sent[0]?.url, "https://decisions.example.com/v1/systemone")
	assert.equal(http.sent[0]?.body.model, "jev-latest")
})

test("the registry gives no decision model when the settings name none, and an error when the model is gone", async () => {
	const none = await Effect.runPromise(
		Effect.flatMap(ModelRegistry.ModelRegistry, (registry) =>
			registry.decision(organizationId),
		).pipe(
			Effect.provide(
				registryWith({
					providers: [provider({ id: "prov_ts", kind: "typesafe" })],
					decisionModel: null,
					http: fakeTypeSafe().layer,
				}),
			),
		),
	)
	assert.ok(Option.isNone(none))
	for (const [providers, message] of [
		[[], /No provider of the organization offers/],
		[
			[provider({ id: "prov_ts", kind: "openai-compat" })],
			/openai-compat provider yet/,
		],
	] as const) {
		const failed = await Effect.runPromise(
			Effect.flatMap(ModelRegistry.ModelRegistry, (registry) =>
				registry.decision(organizationId),
			).pipe(
				Effect.flip,
				Effect.provide(
					registryWith({
						providers,
						decisionModel: selection("prov_ts"),
						http: fakeTypeSafe().layer,
					}),
				),
			),
		)
		assert.ok(failed instanceof Config.ModelConfigurationError)
		assert.match(failed.message, message)
	}
})
