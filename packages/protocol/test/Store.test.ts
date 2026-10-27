import {
	CatalogDiscovery,
	AppConnections,
	MemoryStore,
	Discovery,
	Document,
	Store,
} from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"

// Tests build in-process dependencies with Effect.provide.

const candidate = Discovery.Candidate.make({
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
})
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
			const denied = yield* Effect.flip(add("alice", false))
			assert.ok(denied._tag === "AppError")
			assert.strictEqual(denied.reason, "ConfirmationRequired")
			const apps = yield* Store.AppStore
			const missing = yield* Effect.flip(apps.getApp(candidate.cardUrl))
			assert.strictEqual(missing.reason, "Missing")
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
			const binding = Store.CredentialBinding.make({
				owner: "alice",
				connectionId: "service",
				resource: "https://service.example/mcp",
				issuer: "https://auth.example",
			})
			const reference = yield* credentials.put(
				Store.Credential.make({
					binding,
					accessToken: Redacted.make("secret-a"),
					scopes: ["read"],
				}),
			)
			assert.notInclude(
				yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
					yield* credentials.get({
						binding,
						reference,
					}),
				),
				"secret-a",
			)
			for (const change of [
				{ owner: "bob" },
				{ connectionId: "other" },
				{ resource: "https://other.example/mcp" },
				{ issuer: "https://other-auth.example" },
			]) {
				const failure = yield* Effect.flip(
					credentials.get({ binding: { ...binding, ...change }, reference }),
				)
				assert.strictEqual(failure.reason, "Missing")
			}
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
			const duplicate = yield* Effect.flip(add("alice"))
			assert.ok(duplicate._tag === "StoreError")
			assert.strictEqual(duplicate.reason, "AlreadyExists")
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
		assert.ok(error._tag === "StoreError")
		assert.strictEqual(error.reason, "Unavailable")
		assert.strictEqual(error.operation, "save")
	}),
)

it.effect(
	"An update that moves the connection fails as invalid, and an update of an unknown connection fails as missing",
	() =>
		Effect.gen(function* () {
			const { connection } = yield* add("alice")
			const apps = yield* Store.AppStore
			const moved = yield* Effect.flip(
				apps.update({
					key: connection,
					change: (old) =>
						Store.UserConnection.make({
							...old,
							cardUrl: "https://other.example/card",
						}),
				}),
			)
			assert.strictEqual(moved.reason, "Invalid")
			assert.strictEqual(moved.operation, "update")
			assert.strictEqual(
				(yield* apps.get(connection)).cardUrl,
				candidate.cardUrl,
			)
			const missing = yield* Effect.flip(
				apps.update({
					key: { owner: "bob", connectionId: "service" },
					change: (old) => old,
				}),
			)
			assert.strictEqual(missing.reason, "Missing")
			assert.strictEqual(missing.operation, "update")
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
