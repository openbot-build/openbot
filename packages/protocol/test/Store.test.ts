import assert from "node:assert/strict"
import {
	CatalogDiscovery,
	AppConnections,
	MemoryStore,
	Discovery,
	Document,
	Store,
} from "@openbot-build/protocol"
import { test } from "node:test"
import { ManagedRuntime, Effect, Layer, Redacted } from "effect"

// Tests build in-process dependencies at the edge of their runtime.

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

test("Confirmation saves one shared App record, and each owner keeps its own configuration and credentials", async () => {
	await using runtime1 = ManagedRuntime.make(
		Layer.mergeAll(
			MemoryStore.layer,
			MemoryStore.layerCredentials,
			discovery,
		).pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime1.runPromise(
		Effect.gen(function* () {
			const denied = yield* Effect.result(add("alice", false))
			assert.equal(denied._tag, "Failure")
			const apps = yield* Store.AppStore
			assert.equal(
				(yield* Effect.result(apps.getApp(candidate.cardUrl)))._tag,
				"Failure",
			)
			const alice = yield* add("alice")
			const bob = yield* add("bob")
			assert.equal(alice.connection.cardUrl, bob.connection.cardUrl)
			assert.equal(alice.connection.authorization._tag, "PendingAuthorization")
			assert.deepEqual(Redacted.value(alice.connection.configuration), {
				private: "alice",
			})
			assert.deepEqual(Redacted.value(bob.connection.configuration), {
				private: "bob",
			})
			assert.equal(
				(yield* apps.getApp(candidate.cardUrl)).card.name,
				candidate.card.name,
			)
			assert.equal(alice.publicHints.cardUrl, candidate.cardUrl)
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
				assert.equal(
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
			assert.equal(
				Redacted.value(
					(yield* credentials.get({
						binding,
						reference,
					})).accessToken,
				),
				"secret-a",
			)
			const duplicate = yield* Effect.result(add("alice"))
			assert.equal(duplicate._tag, "Failure")
		}),
	)
})

test("An unavailable store cannot report a successful add", async () => {
	const failing = Layer.succeed(Store.AppStore, {
		save: () =>
			Effect.fail(
				new Store.StoreError({
					reason: "Unavailable",
					operation: "save",
				}),
			),
		get: () =>
			Effect.fail(
				new Store.StoreError({
					reason: "Missing",
					operation: "get",
				}),
			),
		getApp: () =>
			Effect.fail(
				new Store.StoreError({
					reason: "Missing",
					operation: "getApp",
				}),
			),
		update: () =>
			Effect.fail(
				new Store.StoreError({
					reason: "Unavailable",
					operation: "update",
				}),
			),
		updateApp: () => Effect.void,
		delete: () => Effect.void,
	})
	await using runtime2 = ManagedRuntime.make(
		Layer.merge(failing, discovery).pipe(
			Layer.provideMerge([CatalogDiscovery.layerRules]),
		),
	)
	await assert.rejects(runtime2.runPromise(add("alice")), /StoreError/)
})
