import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { DeveloperApi as Api } from "@openbot-build/api"
import { CatalogDiscovery, Document, Network } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Cause,
	Crypto,
	Deferred,
	Effect,
	Formatter,
	Layer,
	Match,
	Option,
	Redacted,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { eq } from "drizzle-orm"
import { TestClock } from "effect/testing"
import { serveHttps } from "../../protocol/test/Fixture.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as DeveloperLayers from "../src/apps/DeveloperLayers.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as IndexStore from "../src/apps/IndexStore.ts"
import * as Governance from "../src/apps/Governance.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import { AppNetwork } from "../src/apps/AppHost.ts"
import * as DomainControl from "../src/apps/DomainControl.ts"
import { DeveloperAccess } from "../src/apps/DeveloperAccess.ts"
import { DeveloperTests } from "../src/apps/DeveloperTests.ts"
import { DeveloperMonitor } from "../src/apps/DeveloperMonitor.ts"
import * as Rows from "../src/apps/DeveloperRows.ts"
import { developerProofs, developerTests } from "../src/database/Schema.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

const Wire = Schema.Struct({
	id: Schema.Union([Schema.Finite, Schema.String]),
	method: Schema.String,
	params: Schema.optionalKey(Schema.JsonObject),
})
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const owner = ownerKey({ organizationId: "developer", userId: "alice" })
const another = ownerKey({ organizationId: "other", userId: "bob" })
type Mode = "normal" | "repeat" | "page-failure" | "optional" | "slow"

const get = (account: string, id: string) =>
	Effect.flatMap(DeveloperTests, (tests) => tests.get(account, id))
/** The stage of a Developer test with this name. */
const stage = (test: Api.ConnectionTest, name: string) =>
	Arr.findFirst(test.stages, (stage) => stage.name === name)
/** True while the cleanup of a Developer test waits, and no reason stops it. */
const cleaning = (test: Api.ConnectionTest) =>
	test.cleanup === "Pending" && test.reason === null
/** True when a Developer test called a business or content method. */
const usedContent = (methods: ReadonlyArray<string>) =>
	Arr.some(methods, (method) =>
		Arr.contains(["tools/call", "resources/read", "prompts/get"], method),
	)

it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	// The App fixture and the database are real servers, so the test uses the
	// real clock. The Developer services run on their own test clock.
	it.effect(
		"independent HTTPS developer tests apply rules for complete pages, optional capabilities, cancellation and owner-only cleanup",
		() =>
			Effect.gen(function* () {
				const crypto = yield* Crypto.Crypto
				const mode = yield* Ref.make<Mode>("normal")
				const origin = yield* Deferred.make<string>()
				const tokens = yield* Ref.make<ReadonlyArray<string>>([])
				const methods = yield* Ref.make<ReadonlyArray<string>>([])
				const closed = yield* Ref.make(0)
				const slowOpened = yield* Deferred.make<void>()
				const failures = yield* Ref.make<ReadonlyArray<Cause.Cause<unknown>>>(
					[],
				)
				const fixture = yield* serveHttps(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const base = yield* Deferred.await(origin)
						if (request.method === "GET") {
							assert.strictEqual(request.headers["authorization"], undefined)
							assert.strictEqual(request.headers["cookie"], undefined)
							const headers = { "cache-control": "no-store" }
							if (request.url === "/card.json") {
								const card: typeof Document.ServerCard.Encoded = {
									$schema: Document.cardSchemaUrl,
									name: "fixture.example/developer",
									version: "1.0.0",
									description: "Independent developer metadata fixture",
									remotes: [
										{
											type: "streamable-http",
											url: base + "/mcp",
											supportedProtocolVersions: [Document.protocolVersion],
										},
										{
											type: "streamable-http",
											url: base + "/configured",
											supportedProtocolVersions: [Document.protocolVersion],
											headers: [
												{
													name: "X-Test-Key",
													isRequired: true,
													isSecret: true,
												},
											],
										},
									],
									_meta: {
										"openbot/developer-verification": {
											version: 1,
											tokens: yield* Ref.get(tokens),
										},
									},
								}
								return yield* HttpServerResponse.json(card, { headers })
							}
							if (request.url === "/.well-known/ai-catalog.json")
								return yield* HttpServerResponse.json(
									{
										specVersion: "1.0",
										entries: [
											{
												identifier: "developer",
												type: Document.cardMediaType,
												url: base + "/card.json",
											},
										],
									},
									{ headers },
								)
							return HttpServerResponse.empty({ status: 404, headers })
						}
						if (request.url === "/configured")
							assert.strictEqual(
								request.headers["x-test-key"],
								"private-fixture-key",
							)
						const input = yield* HttpServerRequest.schemaBodyJson(Wire)
						yield* Ref.update(methods, Arr.append(input.method))
						const current = yield* Ref.get(mode)
						const cursor = input.params?.["cursor"]
						// The answer never ends, so only a cancel closes it. The test sends the
						// cancel only after the answer starts to stream.
						if (current === "slow")
							return HttpServerResponse.stream(
								Stream.make(": waiting\n\n").pipe(
									Stream.tap(() => Deferred.succeed(slowOpened, undefined)),
									Stream.concat(Stream.never),
									Stream.encodeText,
									Stream.ensuring(Ref.update(closed, (count) => count + 1)),
								),
								{ contentType: "text/event-stream" },
							)
						if (
							current === "page-failure" &&
							input.method === "tools/list" &&
							cursor !== undefined
						)
							return HttpServerResponse.empty({ status: 503 })
						const value = Match.value(input.method).pipe(
							Match.when("server/discover", () => ({
								supportedVersions: [Document.protocolVersion],
								capabilities:
									current === "optional"
										? { tools: {} }
										: { tools: {}, resources: {}, prompts: {} },
							})),
							Match.when("tools/list", () => ({
								tools: [
									{
										name: cursor === undefined ? "First" : "Second",
										inputSchema: { type: "object" },
									},
								],
								...(current === "repeat"
									? { nextCursor: "repeat" }
									: cursor === undefined
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
						return yield* HttpServerResponse.json({
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
						})
					}).pipe(
						// The fixture answers a failed check with an error response.
						// So it keeps the failures, and the test checks them at the end.
						Effect.tapCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.void
								: Ref.update(failures, Arr.append(cause)),
						),
					),
				)
				yield* Deferred.succeed(origin, fixture.ipOrigin)
				const cardUrl = fixture.ipOrigin + "/card.json"
				const network = (account: string) =>
					NodeHttpServer.layerUserNetwork({
						owner: account,
						allowedOrigins: [fixture.ipOrigin],
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
				const database = yield* Postgres.start
				const databaseLayer = Database.layer({
					databaseUrl: Redacted.make(database.url),
				})
				yield* Effect.provide(Database.migrate, databaseLayer)
				const layer = DeveloperLayers.layer.pipe(
					Layer.provide(
						Layer.mergeAll(
							publicNetwork,
							Layer.succeed(AppNetwork, {
								layer: (account) => network(account),
							}),
							DomainControl.layer,
						),
					),
					Layer.provide(discovery),
					Layer.provide(IndexStore.layer),
					Layer.provide(Governance.layer),
					Layer.provide(
						OrganizationFixture.layerSettings({
							publicOrigin: "https://localhost",
						}),
					),
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
					Layer.provideMerge(databaseLayer),
					Layer.provideMerge(TestClock.layer()),
				)
				/**
				 * Starts the Developer services. They stop when the scope closes,
				 * and the next start reads the stored state again, like a restart.
				 */
				const start = Effect.gen(function* () {
					const run = Effect.provide(yield* Layer.build(layer))
					const create = Effect.fn("DeveloperConnectionTests.create")(
						function* (remoteIndex: number = 0) {
							const id = yield* crypto.randomUUIDv4()
							return yield* run(
								Effect.flatMap(DeveloperTests, (tests) =>
									tests.create(owner, { id, cardUrl, remoteIndex }),
								),
							)
						},
					)
					const settle = Effect.fn("DeveloperConnectionTests.settle")(
						function* (id: string) {
							const test = yield* run(get(owner, id)).pipe(
								Effect.repeat({
									until: (test) => test.status !== "Running",
									schedule: Schedule.spaced("10 millis"),
									times: 100,
								}),
							)
							assert.notStrictEqual(test.status, "Running")
							return test
						},
					)
					return { run, create, settle }
				})

				const { proof, configured } = yield* Effect.scoped(
					Effect.gen(function* () {
						const { run, create } = yield* start
						const proof = yield* run(
							Effect.gen(function* () {
								const access = yield* DeveloperAccess
								const claim = yield* access.start(owner, {
									_tag: "AppCard",
									cardUrl,
								})
								yield* Ref.set(tokens, [claim.token])
								return yield* access.verify(owner, claim.id)
							}),
						)
						yield* run(
							Effect.gen(function* () {
								const access = yield* DeveloperAccess
								const challenge = yield* access.start(another, {
									_tag: "AppCard",
									cardUrl,
								})
								yield* Ref.update(tokens, Arr.append(challenge.token))
								yield* access.verify(another, challenge.id)
							}),
						)
						const configured = yield* create(1)
						assert.strictEqual(configured.status, "AwaitingConfiguration")
						const invalid = yield* run(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.configure(owner, configured.id, {}),
							).pipe(Effect.flip),
						)
						assert.strictEqual(invalid._tag, "DeveloperInputInvalid")
						yield* run(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.configure(owner, configured.id, {
									"header:X-Test-Key": "private-fixture-key",
								}),
							),
						)
						const view = yield* encodeJson(
							yield* run(get(owner, configured.id)),
						)
						assert.strictEqual(Str.includes("private-fixture-key")(view), false)
						const stored = yield* encodeJson(
							yield* run(
								Effect.flatMap(Db.make, (db) =>
									db
										.select({ privateState: developerTests.privateState })
										.from(developerTests),
								),
							),
						)
						assert.strictEqual(
							Str.includes("private-fixture-key")(stored),
							false,
						)
						return { proof, configured }
					}),
				)

				const remembered = yield* Effect.scoped(
					Effect.gen(function* () {
						const { run, create, settle } = yield* start
						assert.strictEqual(
							(yield* run(get(owner, configured.id))).status,
							"Queued",
						)
						yield* run(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.run(owner, configured.id),
							),
						)
						assert.strictEqual(
							(yield* settle(configured.id)).status,
							"Succeeded",
						)
						for (const selected of [
							"normal",
							"repeat",
							"page-failure",
							"optional",
						] as const) {
							yield* Ref.set(mode, selected)
							yield* Ref.set(methods, [])
							const test = yield* create()
							yield* run(
								Effect.flatMap(DeveloperTests, (tests) =>
									tests.run(owner, test.id),
								),
							)
							const result = yield* settle(test.id)
							assert.strictEqual(
								result.status,
								selected === "repeat" || selected === "page-failure"
									? "Failed"
									: "Succeeded",
								Formatter.format(result),
							)
							if (selected === "normal")
								assert.deepStrictEqual(
									Option.map(
										stage(result, "tools"),
										(tools) => tools.items.length,
									),
									Option.some(2),
								)
							if (selected === "repeat" || selected === "page-failure")
								assert.deepStrictEqual(
									Option.map(
										stage(result, "resources"),
										(resources) => resources.status,
									),
									Option.some("NotChecked"),
									Formatter.format(result),
								)
							if (selected === "page-failure")
								assert.deepStrictEqual(
									Option.map(
										stage(result, "tools"),
										(tools) => tools.items.length,
									),
									Option.some(1),
								)

							if (selected === "optional") {
								assert.deepStrictEqual(
									Option.map(
										stage(result, "resources"),
										(resources) => resources.status,
									),
									Option.some("NotAdvertised"),
								)
								assert.strictEqual(
									Arr.contains(yield* Ref.get(methods), "resources/list"),
									false,
								)
							}
							assert.strictEqual(
								(yield* run(Effect.flip(get(another, test.id))))._tag,
								"DeveloperNotFound",
							)
						}
						yield* Ref.set(mode, "slow")
						const slow = yield* create()
						yield* run(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.run(owner, slow.id),
							),
						)
						yield* Deferred.await(slowOpened).pipe(Effect.timeout("5 seconds"))
						yield* run(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.cancel(owner, slow.id),
							),
						)
						const cancelled = yield* settle(slow.id)
						assert.strictEqual(
							cancelled.cleanup,
							"Complete",
							Formatter.format(cancelled),
						)
						const closes = yield* Ref.get(closed).pipe(
							Effect.repeat({
								until: (count) => count > 0,
								schedule: Schedule.spaced("10 millis"),
								times: 50,
							}),
						)
						assert.ok(
							closes > 0,
							"Cancelling must close the independent HTTPS response.",
						)
						yield* Ref.set(mode, "normal")
						const expiring = yield* create()
						yield* run(TestClock.adjust("2 hours"))
						// A stored test that does not decode must not stop the cleanup of the others.
						const brokenTest = eq(developerTests.id, "broken-test")
						yield* run(
							Effect.flatMap(Db.make, (db) =>
								db.insert(developerTests).values({
									namespace: "public",
									id: "broken-test",
									owner,
									cardUrl,
									status: "Running",
									cleanup: "Pending",
									expiresAt: 0,
									value: "{}",
								}),
							),
						)
						yield* run(Effect.flatMap(DeveloperTests, (tests) => tests.sweep))
						const expired = yield* settle(expiring.id).pipe(
							Effect.repeat({
								until: (test) => !cleaning(test),
								schedule: Schedule.spaced("10 millis"),
								times: 100,
							}),
						)
						assert.strictEqual(
							expired.cleanup,
							"Complete",
							Formatter.format(expired),
						)
						yield* run(
							Effect.flatMap(Db.make, (db) =>
								db.delete(developerTests).where(brokenTest),
							),
						)
						// A stored proof that does not decode must not stop the monitor.
						yield* run(
							Effect.gen(function* () {
								const db = yield* Db.make
								const where = eq(developerProofs.id, proof.id)
								const stored = yield* Effect.fromOption(
									Arr.head(
										yield* db.select().from(developerProofs).where(where),
									),
								)
								yield* db
									.update(developerProofs)
									.set({ scope: "{", nextVerificationAt: 0 })
									.where(where)
								yield* (yield* DeveloperMonitor).run
								yield* db
									.update(developerProofs)
									.set({
										scope: stored.scope,
										nextVerificationAt: stored.nextVerificationAt,
									})
									.where(where)
							}),
						)
						// A completion that cannot open its callback must not leave the
						// test authorization in `Exchanging`.
						const exchanging = yield* create()
						yield* run(
							Effect.gen(function* () {
								const db = yield* Db.make
								const record = yield* Rows.getTest(db, "public", exchanging.id)
								const authorization: Api.TestAuthorization = {
									flowId: yield* crypto.randomUUIDv4(),
									status: "Received",
									issuer: fixture.ipOrigin,
									resource: fixture.ipOrigin + "/mcp",
									scopes: [],
									expiresAt: record.value.expiresAt,
									authorizationUrl: "",
								}
								yield* Rows.putFlow(db, "public", {
									owner,
									testId: exchanging.id,
									body: null,
									callback: "not-sealed",
									consumed: false,
									value: authorization,
								})
								yield* Rows.putTest(db, "public", {
									...record,
									value: {
										...record.value,
										status: "AwaitingAuthorization",
										authorization,
									},
								})
							}),
						)
						const completion = yield* run(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.complete(owner, exchanging.id),
							).pipe(Effect.flip),
						)
						assert.strictEqual(completion._tag, "DeveloperUnavailable")
						const afterCut = yield* run(get(owner, exchanging.id))
						assert.strictEqual(afterCut.status, "AwaitingAuthorization")
						assert.strictEqual(afterCut.authorization?.status, "Failed")
						assert.strictEqual(afterCut.reason, "AuthorizationCouldNotComplete")
						const remembered = (yield* create()).id
						yield* run(
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
						return remembered
					}),
				)

				yield* Effect.scoped(
					Effect.gen(function* () {
						const { run } = yield* start
						const restored = yield* run(
							Effect.flatMap(Db.make, (db) =>
								Rows.getTest(db, "public", remembered),
							),
						)
						assert.strictEqual(restored.value.status, "Interrupted")
						yield* run(
							Effect.gen(function* () {
								yield* (yield* DeveloperAccess).relinquish(owner, proof.id)
								assert.strictEqual(
									(yield* (yield* DeveloperTests).get(owner, remembered)).stages
										.length,
									0,
								)
							}),
						)
						yield* run(
							Effect.flatMap(DeveloperTests, (tests) =>
								tests.cleanup(owner, remembered),
							),
						)
						const cleaned = yield* run(get(owner, remembered)).pipe(
							Effect.repeat({
								until: (test) => !cleaning(test),
								schedule: Schedule.spaced("10 millis"),
								times: 300,
							}),
						)
						assert.strictEqual(
							cleaned.cleanup,
							"Complete",
							Formatter.format(cleaned),
						)
					}),
				)

				assert.strictEqual(usedContent(yield* Ref.get(methods)), false)
				assert.deepStrictEqual(yield* Ref.get(failures), [])
			}),
		{ timeout: 30000 },
	)
})
