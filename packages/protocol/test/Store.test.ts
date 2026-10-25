// Tests are entry points, so they provide their own Layers.
// @effect-diagnostics strictEffectProvide:off
import {
	CatalogDiscovery,
	AppConnections,
	MemoryStore,
	Discovery,
	Document,
	Store,
} from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"

// Tests build in-process dependencies with Effect.provide.

const candidate: Discovery.Candidate = {
	cardUrl: "https://service.example/card",
	card: {
		$schema: Document.cardSchemaUrl,
		name: "example.test/service",
		version: "1.0.0",
		description: "A service",
		remotes: [
			{
				type: "streamable-http",
				url: "https://service.example/mcp",
				supportedProtocolVersions: [Document.protocolVersion],
			},
		],
	},
	endpoints: [
		{
			index: 0,
			remote: {
				type: "streamable-http",
				url: "https://service.example/mcp",
				supportedProtocolVersions: [Document.protocolVersion],
			},
			requirements: [],
		},
	],
	sources: [{ role: "card", url: "https://service.example/card" }],
}
const discovery = Layer.succeed(Discovery.Discovery, {
	resolve: () => Effect.succeed({ _tag: "Single", candidate, issues: [] }),
	refreshCard: () => Effect.succeed(candidate),
	refresh: () => Effect.succeed({ _tag: "DescriptionUpdated", candidate }),
})
const add = (owner: string, confirmed: boolean = true) =>
	AppConnections.add({
		key: { owner, connectionId: "service" },
		candidate,
		remoteIndex: 0,
		values: { private: owner },
		confirmed,
		requiresAuthorization: true,
	})

it.effect(
	"Confirmation saves one shared App record, and each owner keeps its own configuration and credentials",
	() =>
		Effect.gen(function* () {
			const denied = yield* Effect.result(add("alice", false))
			assert.strictEqual(denied._tag, "Failure")
			const apps = yield* Store.AppStore
			assert.strictEqual(
				(yield* Effect.result(apps.getApp(candidate.cardUrl)))._tag,
				"Failure",
			)
			const alice = yield* add("alice")
			const bob = yield* add("bob")
			assert.strictEqual(alice.connection.cardUrl, bob.connection.cardUrl)
			assert.strictEqual(
				alice.connection.authorization._tag,
				"PendingAuthorization",
			)
			assert.deepStrictEqual(Redacted.value(alice.connection.configuration), {
				private: "alice",
			})
			assert.deepStrictEqual(Redacted.value(bob.connection.configuration), {
				private: "bob",
			})
			assert.strictEqual(
				(yield* apps.getApp(candidate.cardUrl)).card.name,
				candidate.card.name,
			)
			assert.strictEqual(alice.publicHints.cardUrl, candidate.cardUrl)
			const credentials = yield* Store.CredentialStore
			const binding = {
				owner: "alice",
				connectionId: "service",
				resource: "https://service.example/mcp",
				issuer: "https://auth.example",
			}
			const reference = yield* credentials.put({
				binding,
				accessToken: Redacted.make("secret-a"),
				scopes: ["read"],
			})
			assert.ok(
				!JSON.stringify(
					yield* credentials.get({
						binding,
						reference,
					}),
				).includes("secret-a"),
			)
			for (const change of [
				{ owner: "bob" },
				{ connectionId: "other" },
				{ resource: "https://other.example/mcp" },
				{ issuer: "https://other-auth.example" },
			])
				assert.strictEqual(
					(yield* Effect.result(
						credentials.get({
							binding: {
								...binding,
								...change,
							},
							reference,
						}),
					))._tag,
					"Failure",
				)
			yield* credentials.deleteConnection({
				owner: "bob",
				connectionId: "service",
			})
			assert.strictEqual(
				Redacted.value(
					(yield* credentials.get({
						binding,
						reference,
					})).accessToken,
				),
				"secret-a",
			)
			const duplicate = yield* Effect.result(add("alice"))
			assert.strictEqual(duplicate._tag, "Failure")
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					MemoryStore.layer,
					MemoryStore.layerCredentials,
					discovery,
				).pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
			),
		),
)

it.effect("An unavailable store cannot report a successful add", () =>
	Effect.gen(function* () {
		const failing = Layer.succeed(Store.AppStore, {
			save: () =>
				Effect.fail(
					Store.StoreError.make({
						reason: "Unavailable",
						operation: "save",
					}),
				),
			get: () =>
				Effect.fail(
					Store.StoreError.make({
						reason: "Missing",
						operation: "get",
					}),
				),
			getApp: () =>
				Effect.fail(
					Store.StoreError.make({
						reason: "Missing",
						operation: "getApp",
					}),
				),
			update: () =>
				Effect.fail(
					Store.StoreError.make({
						reason: "Unavailable",
						operation: "update",
					}),
				),
			updateApp: () => Effect.void,
			delete: () => Effect.void,
		})
		const error = yield* Effect.flip(
			add("alice").pipe(
				Effect.provide(
					Layer.merge(failing, discovery).pipe(
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			),
		)
		assert.match(String(error), /StoreError/)
	}),
)
