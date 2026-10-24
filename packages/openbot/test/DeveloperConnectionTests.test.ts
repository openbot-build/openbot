// @effect-diagnostics strictEffectProvide:off
import { randomUUID } from "node:crypto"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { CatalogDiscovery, Document, Network } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { Effect, Layer, ManagedRuntime, Match, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { startHttps } from "../../protocol/test/Fixture.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as DeveloperLayers from "../src/apps/DeveloperLayers.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as IndexStore from "../src/apps/IndexStore.ts"
import * as Governance from "../src/apps/Governance.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { DeveloperAccess } from "../src/apps/DeveloperAccess.ts"
import { DeveloperTests } from "../src/apps/DeveloperTests.ts"
import * as Rows from "../src/apps/DeveloperRows.ts"
import { developerTests } from "../src/database/Schema.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

const Wire = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.Union([Schema.Finite, Schema.String]),
		method: Schema.String,
		params: Schema.optionalKey(Schema.JsonObject),
	}),
)
const owner = ownerKey({ organizationId: "developer", userId: "alice" })
const another = ownerKey({ organizationId: "other", userId: "bob" })
it(
	"independent HTTPS developer tests apply rules for complete pages, optional capabilities, cancellation and owner-only cleanup",
	{ timeout: 30000 },
	async () => {
		let mode: "normal" | "repeat" | "page-failure" | "optional" | "slow" =
			"normal"
		let origin = ""
		let tokens: ReadonlyArray<string> = []
		let methods: ReadonlyArray<string> = []
		let closed = 0
		const fixture = await startHttps((request, response) => {
			const cardUrl = origin + "/card.json"
			const card: Document.ServerCard = {
				$schema: Document.cardSchemaUrl,
				name: "fixture.example/developer",
				version: "1.0.0",
				description: "Independent developer metadata fixture",
				remotes: [
					{
						type: "streamable-http",
						url: origin + "/mcp",
						supportedProtocolVersions: [Document.protocolVersion],
					},
					{
						type: "streamable-http",
						url: origin + "/configured",
						supportedProtocolVersions: [Document.protocolVersion],
						headers: [{ name: "X-Test-Key", isRequired: true, isSecret: true }],
					},
				],
				_meta: { "openbot/developer-verification": { version: 1, tokens } },
			}
			if (request.method === "GET") {
				assert.strictEqual(request.headers.authorization, undefined)
				assert.strictEqual(request.headers.cookie, undefined)
				response.setHeader("content-type", "application/json")
				response.setHeader("cache-control", "no-store")
				if (request.url === "/card.json") response.end(JSON.stringify(card))
				else if (request.url === "/.well-known/ai-catalog.json")
					response.end(
						JSON.stringify({
							specVersion: "1.0",
							entries: [
								{
									identifier: "developer",
									type: Document.cardMediaType,
									url: cardUrl,
								},
							],
						}),
					)
				else {
					response.statusCode = 404
					response.end()
				}
				return
			}
			if (request.url === "/configured")
				assert.strictEqual(request.headers["x-test-key"], "private-fixture-key")
			let body = ""
			request.setEncoding("utf8")
			request.on("data", (part: string) => {
				body += part
			})
			request.on("end", () => {
				const input = Schema.decodeSync(Wire)(body)
				methods = [...methods, input.method]
				if (mode === "slow") {
					response.writeHead(200, { "content-type": "text/event-stream" })
					response.write(": waiting\n\n")
					response.on("close", () => {
						closed++
					})
					return
				}
				if (
					mode === "page-failure" &&
					input.method === "tools/list" &&
					input.params?.["cursor"] !== undefined
				) {
					response.writeHead(503)
					response.end()
					return
				}
				const value = Match.value(input.method).pipe(
					Match.when("server/discover", () => ({
						supportedVersions: [Document.protocolVersion],
						capabilities:
							mode === "optional"
								? { tools: {} }
								: { tools: {}, resources: {}, prompts: {} },
					})),
					Match.when("tools/list", () => ({
						tools: [
							{
								name:
									input.params?.["cursor"] === undefined ? "First" : "Second",
								inputSchema: { type: "object" },
							},
						],
						...(mode === "repeat"
							? { nextCursor: "repeat" }
							: input.params?.["cursor"] === undefined
								? { nextCursor: "second" }
								: {}),
					})),
					Match.when("resources/list", () => ({ resources: [] })),
					Match.when("resources/templates/list", () => ({
						resourceTemplates: [],
					})),
					Match.when("prompts/list", () => ({ prompts: [] })),
					Match.orElse(() => {
						assert.fail(
							"Developer tests must not call business or content methods.",
						)
					}),
				)
				response.writeHead(200, { "content-type": "application/json" })
				response.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: input.id,
						result: {
							resultType: "complete",
							...value,
							ttlMs: 0,
							cacheScope: "private",
							_meta: {
								"io.modelcontextprotocol/serverInfo": {
									name: "independent-developer-fixture",
									version: "1.0.0",
								},
							},
						},
					}),
				)
			})
		})
		origin = fixture.ipOrigin
		const network = (account: string) =>
			NodeHttpServer.layerUserNetwork({
				owner: account,
				allowedOrigins: [origin],
				allowAddress: (address) => address === "127.0.0.1",
				ca: fixture.ca,
			})
		const publicNetwork = Layer.effect(
			Network.PublicNetwork,
			Effect.map(Network.Network, (network) =>
				Network.PublicNetwork.of({ readDocument: network.readDocument }),
			),
		).pipe(Layer.provide(network("public-fixture")))
		const discovery = CatalogDiscovery.layer().pipe(
			Layer.provide(CatalogDiscovery.layerRules),
			Layer.provide(network("public-fixture")),
		)
		const database = await Postgres.start()
		await using migration = ManagedRuntime.make(
			Database.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
				Layer.provide(NodeServices.layer),
			),
		)
		await migration.runPromise(Database.migrate)
		const layer = DeveloperLayers.layer({
			publicNetwork,
			appNetwork: Layer.succeed(AppNetwork, {
				layer: (account) => network(account),
			}),
		}).pipe(
			Layer.provide(discovery),
			Layer.provide(IndexStore.layer),
			Layer.provide(
				Governance.layer.pipe(
					Layer.provide(OrganizationFixture.layerDefaultSettings),
				),
			),
			Layer.provide(Secrets.layer(Redacted.make("test:" + "11".repeat(32)))),
			Layer.provideMerge(
				Database.layer({ databaseUrl: Redacted.make(database.url) }),
			),
			Layer.provideMerge(TestClock.layer()),
			Layer.provide(NodeServices.layer),
		)
		let runtime = ManagedRuntime.make(layer)
		let remembered = ""
		try {
			const proof = await runtime.runPromise(
				Effect.gen(function* () {
					const access = yield* DeveloperAccess
					const claim = yield* access.start(owner, {
						_tag: "AppCard",
						cardUrl: origin + "/card.json",
					})
					tokens = [claim.token]
					return yield* access.verify(owner, claim.id)
				}),
			)
			await runtime.runPromise(
				Effect.gen(function* () {
					const access = yield* DeveloperAccess
					const challenge = yield* access.start(another, {
						_tag: "AppCard",
						cardUrl: origin + "/card.json",
					})
					tokens = [...tokens, challenge.token]
					yield* access.verify(another, challenge.id)
				}),
			)
			const create = (remoteIndex = 0) =>
				runtime.runPromise(
					Effect.flatMap(DeveloperTests, (tests) =>
						tests.create(owner, {
							id: randomUUID(),
							cardUrl: origin + "/card.json",
							remoteIndex,
						}),
					),
				)
			const settle = async (id: string) => {
				let value = await runtime.runPromise(
					Effect.flatMap(DeveloperTests, (tests) => tests.get(owner, id)),
				)
				for (
					let attempt = 0;
					value.status === "Running" && attempt < 100;
					attempt++
				) {
					await new Promise((resolve) => setTimeout(resolve, 10))
					value = await runtime.runPromise(
						Effect.flatMap(DeveloperTests, (tests) => tests.get(owner, id)),
					)
				}
				assert.notStrictEqual(value.status, "Running")
				return value
			}
			const configured = await create(1)
			assert.strictEqual(configured.status, "AwaitingConfiguration")
			const invalid = await runtime.runPromise(
				Effect.flatMap(DeveloperTests, (tests) =>
					tests.configure(owner, configured.id, {}),
				).pipe(Effect.flip),
			)
			assert.strictEqual(invalid._tag, "DeveloperInputInvalid")
			await runtime.runPromise(
				Effect.flatMap(DeveloperTests, (tests) =>
					tests.configure(owner, configured.id, {
						"header:X-Test-Key": "private-fixture-key",
					}),
				),
			)
			assert.strictEqual(
				JSON.stringify(
					await runtime.runPromise(
						Effect.flatMap(DeveloperTests, (tests) =>
							tests.get(owner, configured.id),
						),
					),
				).includes("private-fixture-key"),
				false,
			)
			assert.strictEqual(
				JSON.stringify(
					await runtime.runPromise(
						Effect.flatMap(Db.make, (db) =>
							db
								.select({ privateState: developerTests.privateState })
								.from(developerTests),
						),
					),
				).includes("private-fixture-key"),
				false,
			)
			await runtime.dispose()
			runtime = ManagedRuntime.make(layer)
			assert.strictEqual(
				(
					await runtime.runPromise(
						Effect.flatMap(DeveloperTests, (tests) =>
							tests.get(owner, configured.id),
						),
					)
				).status,
				"Queued",
			)
			await runtime.runPromise(
				Effect.flatMap(DeveloperTests, (tests) =>
					tests.run(owner, configured.id),
				),
			)
			assert.strictEqual((await settle(configured.id)).status, "Succeeded")
			for (const selected of [
				"normal",
				"repeat",
				"page-failure",
				"optional",
			] as const) {
				mode = selected
				methods = []
				const test = await create()
				remembered = test.id
				await runtime.runPromise(
					Effect.flatMap(DeveloperTests, (tests) => tests.run(owner, test.id)),
				)
				const result = await settle(test.id)
				assert.strictEqual(
					result.status,
					selected === "repeat" || selected === "page-failure"
						? "Failed"
						: "Succeeded",
					JSON.stringify(result),
				)
				if (selected === "normal")
					assert.strictEqual(
						result.stages.find((stage) => stage.name === "tools")?.items.length,
						2,
					)
				if (selected === "repeat" || selected === "page-failure")
					assert.strictEqual(
						result.stages.find((stage) => stage.name === "resources")?.status,
						"NotChecked",
						JSON.stringify(result),
					)
				if (selected === "page-failure")
					assert.strictEqual(
						result.stages.find((stage) => stage.name === "tools")?.items.length,
						1,
					)

				if (selected === "optional") {
					assert.strictEqual(
						result.stages.find((stage) => stage.name === "resources")?.status,
						"NotAdvertised",
					)
					assert.strictEqual(methods.includes("resources/list"), false)
				}
				assert.strictEqual(
					(
						await runtime.runPromise(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.get(another, test.id),
							).pipe(Effect.flip),
						)
					)._tag,
					"DeveloperNotFound",
				)
			}
			mode = "slow"
			const slow = await create()
			await runtime.runPromise(
				Effect.flatMap(DeveloperTests, (tests) => tests.run(owner, slow.id)),
			)
			await new Promise((resolve) => setTimeout(resolve, 50))
			await runtime.runPromise(
				Effect.flatMap(DeveloperTests, (tests) => tests.cancel(owner, slow.id)),
			)
			const cancelled = await settle(slow.id)
			assert.strictEqual(
				cancelled.cleanup,
				"Complete",
				JSON.stringify(cancelled),
			)
			for (let attempt = 0; closed === 0 && attempt < 50; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 10))
			assert.ok(
				closed > 0,
				"Cancelling must close the independent HTTPS response.",
			)
			mode = "normal"
			const expiring = await create()
			await runtime.runPromise(TestClock.adjust("2 hours"))
			await runtime.runPromise(
				Effect.flatMap(DeveloperTests, (tests) => tests.sweep),
			)
			let expired = await settle(expiring.id)
			for (
				let attempt = 0;
				expired.cleanup === "Pending" &&
				expired.reason === null &&
				attempt < 100;
				attempt++
			) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				expired = await settle(expiring.id)
			}
			assert.strictEqual(expired.cleanup, "Complete", JSON.stringify(expired))
			remembered = (await create()).id
			await runtime.runPromise(
				Effect.gen(function* () {
					const db = yield* Db.make
					const record = yield* Rows.getTest(db, "public", remembered)
					yield* Rows.putTest(db, "public", {
						...record,
						value: {
							...record.value,
							status: "Running",
							cleanup: "NotRequired",
						},
					})
				}),
			)
			await runtime.dispose()
			runtime = ManagedRuntime.make(layer)
			const restored = await runtime.runPromise(
				Effect.flatMap(Db.make, (db) => Rows.getTest(db, "public", remembered)),
			)
			assert.strictEqual(restored.value.status, "Interrupted")
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* (yield* DeveloperAccess).relinquish(owner, proof.id)
					assert.strictEqual(
						(yield* (yield* DeveloperTests).get(owner, remembered)).stages
							.length,
						0,
					)
				}),
			)
			let cleaned = await runtime.runPromise(
				Effect.flatMap(DeveloperTests, (tests) =>
					tests.cleanup(owner, remembered),
				),
			)
			for (
				let attempt = 0;
				cleaned.cleanup === "Pending" &&
				cleaned.reason === null &&
				attempt < 300;
				attempt++
			) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				cleaned = await runtime.runPromise(
					Effect.flatMap(DeveloperTests, (tests) =>
						tests.get(owner, remembered),
					),
				)
			}
			assert.strictEqual(cleaned.cleanup, "Complete", JSON.stringify(cleaned))

			assert.strictEqual(
				methods.some((method) =>
					["tools/call", "resources/read", "prompts/get"].includes(method),
				),
				false,
			)
		} finally {
			await runtime.dispose()
			await database.close()
			await fixture.close()
		}
	},
)
