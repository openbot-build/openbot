import * as TestCleanup from "../src/apps/TestCleanup.ts"
import * as TestCleanupWorkflow from "../src/apps/TestCleanupWorkflow.ts"
import * as GrantCleanup from "../src/apps/GrantCleanup.ts"
import * as GrantCleanupWorkflow from "../src/apps/GrantCleanupWorkflow.ts"
import { DeveloperTestRuntime } from "../src/apps/DeveloperTestRuntime.ts"
import { Authorization, Execution } from "@openbot-build/domain"
import * as TestCommands from "../src/apps/TestCommands.ts"
import * as TestWorkflow from "../src/apps/TestWorkflow.ts"
import * as ExecutionEngine from "../src/execution/Engine.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as Runner from "../src/execution/Runner.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import { Billing } from "../src/billing/Billing.ts"
import { WorkflowEngine } from "effect/workflow"
import * as Records from "../src/errors/Records.ts"
import * as TokensPostgres from "../src/auth/TokensPostgres.ts"
import * as IndexCommandsFixture from "./IndexCommandsFixture.ts"
import * as ExecutionStorage from "../src/execution/Store.ts"
import * as ExecutionObservation from "../src/execution/Observation.ts"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { DeveloperApi as Api } from "@openbot-build/api"
import {
	AppConnections,
	CatalogDiscovery,
	Document,
	Network,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Cause,
	Crypto,
	Clock,
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
const cleanupTest = (id: string) =>
	Effect.gen(function* () {
		const cleanup = yield* TestCleanup.TestCleanup
		const receipt = yield* cleanup.request(
			{ kind: "member", organizationId: "developer", userId: "alice" },
			id,
			Execution.CommandKey.make("cleanup:" + id),
			false,
		)
		yield* TestCleanupWorkflow.workflow.execute({
			namespace: owner,
			id: receipt.executionId,
		})
		return receipt
	})
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
				const liveClock = yield* Clock.Clock
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
							if (request.url === "/v1/apps/client-metadata")
								return yield* HttpServerResponse.json(
									{
										client_id: base + "/v1/apps/client-metadata",
										client_name: "Test",
										redirect_uris: [base + "/auth/developer/apps/callback"],
										grant_types: ["authorization_code"],
										response_types: ["code"],
										token_endpoint_auth_method: "none",
									},
									{ headers },
								)
							if (request.url === "/.well-known/oauth-protected-resource/mcp")
								return yield* HttpServerResponse.json(
									{ resource: base + "/mcp", authorization_servers: [base] },
									{ headers },
								)
							if (request.url === "/.well-known/oauth-authorization-server")
								return yield* HttpServerResponse.json(
									{
										issuer: base,
										authorization_endpoint: base + "/authorize",
										token_endpoint: base + "/token",
										client_id_metadata_document_supported: true,
										code_challenge_methods_supported: ["S256"],
										response_types_supported: ["code"],
									},
									{ headers },
								)

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
				const layer = Layer.mergeAll(
					TestWorkflow.layer,
					TestCleanupWorkflow.layer,
					GrantCleanupWorkflow.layer,
					ExecutionEngine.layerOutbox.pipe(
						Layer.provide(Layer.succeed(Clock.Clock, liveClock)),
					),
				).pipe(
					Layer.provideMerge(
						DeveloperLayers.services.pipe(
							Layer.provide(AppConnections.layerConnectionScopes),
						),
					),
					Layer.provideMerge(GrantCleanup.layer),
					Layer.provideMerge(
						Layer.mergeAll(Calls.layer, Runner.layer, RunScope.layer),
					),
					Layer.provideMerge(ExecutionEngine.layerRegistry),
					Layer.provideMerge(WorkflowEngine.layerMemory),
					Layer.provide(
						Layer.mock(Billing, {
							releaseExecution: () => Effect.succeed(true),
						}),
					),
					Layer.provide(IndexCommandsFixture.layer),
					Layer.provide(
						ExecutionObservation.layer.pipe(
							Layer.provideMerge(
								Layer.merge(ExecutionStorage.layer, Records.layer),
							),
						),
					),
					Layer.provide(
						// Keep the authorizer's default settings inside its layer.
						// The Developer services need the HTTPS fixture's public origin.
						Layer.effect(Authorization.Auth, Authorization.Auth).pipe(
							Layer.provide(
								OrganizationFixture.layerAuthorization.pipe(
									Layer.provide(TokensPostgres.layer),
								),
							),
						),
					),
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
							publicOrigin: fixture.ipOrigin,
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
					const runTest = (id: string) =>
						Effect.gen(function* () {
							const commands = yield* TestCommands.TestCommands
							const receipt = yield* commands.request(
								{
									kind: "member",
									organizationId: "developer",
									userId: "alice",
								},
								id,
								Execution.CommandKey.make(yield* crypto.randomUUIDv4()),
							)
							yield* TestWorkflow.workflow.execute(
								{ namespace: owner, id: receipt.executionId },
								{ discard: true },
							)
							return receipt
						})

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
					return { run, create, settle, runTest }
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
								return yield* access.confirm(
									owner,
									claim.id,
									{ _tag: "Matched" },
									yield* access.inspectScope(claim.scope),
								)
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
								yield* access.confirm(
									another,
									challenge.id,
									{ _tag: "Matched" },
									yield* access.inspectScope(challenge.scope),
								)
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
						const { run, create, settle, runTest } = yield* start
						const conflict = Execution.Conflict.make({
							id: Execution.Id.make("old-owner"),
						})
						const stopped = yield* run(
							Effect.flatMap(DeveloperTestRuntime, (runtime) =>
								runtime.execute(owner, configured.id, {
									check: Effect.fail(conflict),
									progress: () => Effect.void,
								}),
							).pipe(Effect.flip),
						)
						assert.strictEqual(stopped._tag, "ExecutionConflict")
						const signIn = yield* create()
						const preparation = yield* run(
							Effect.gen(function* () {
								const db = yield* Db.make
								const record = yield* Rows.getTest(db, "public", signIn.id)
								yield* Rows.putTest(db, "public", {
									...record,
									value: {
										...record.value,
										status: "AwaitingAuthorization",
										issuers: [fixture.ipOrigin],
									},
								})
								const commands = yield* TestCommands.TestCommands
								const receipt = yield* commands.prepare(
									{
										kind: "member",
										organizationId: "developer",
										userId: "alice",
									},
									signIn.id,
									{ scopes: [] },
									Execution.CommandKey.make("prepare-https"),
								)
								yield* TestWorkflow.workflow.execute(
									{ namespace: owner, id: receipt.executionId },
									{ discard: true },
								)
								return receipt
							}),
						)
						const ready = yield* run(get(owner, signIn.id)).pipe(
							Effect.repeat({
								until: (test) => test.status !== "PreparingAuthorization",
								schedule: Schedule.spaced("10 millis"),
								times: 200,
							}),
						)
						assert.strictEqual(
							ready.status,
							"AwaitingAuthorization",
							Formatter.format(ready),
						)
						assert.strictEqual(
							ready.authorization?.status,
							"Waiting",
							Formatter.format(ready),
						)
						assert.strictEqual(ready.executionId, preparation.executionId)
						const authorizationUrl = new URL(
							ready.authorization!.authorizationUrl,
						)
						assert.strictEqual(
							authorizationUrl.searchParams.get("code_challenge_method"),
							"S256",
						)
						assert.strictEqual(
							authorizationUrl.searchParams.get("state"),
							ready.authorization!.flowId,
						)
						yield* run(cleanupTest(signIn.id))

						assert.strictEqual(
							(yield* run(get(owner, configured.id))).status,
							"Queued",
						)
						yield* run(runTest(configured.id))
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
							yield* run(runTest(test.id))
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
						yield* run(runTest(slow.id))
						yield* Deferred.await(slowOpened).pipe(Effect.timeout("5 seconds"))
						const busy = yield* run(
							Effect.flatMap(TestCommands.TestCommands, (commands) =>
								commands.exchange(
									{
										kind: "member",
										organizationId: "developer",
										userId: "alice",
									},
									slow.id,
									Execution.CommandKey.make("slow-exchange"),
								),
							).pipe(Effect.flip),
						)
						assert.propertyVal(busy, "reason", "TestBusy")

						yield* run(cleanupTest(slow.id))
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
						// Expiry starts in the background. NotRequired does not mean it is done.
						const expired = yield* settle(expiring.id).pipe(
							Effect.repeat({
								until: (test) => test.cleanup === "Complete",
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
						// A bad proof fails its own check before any network call.
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
								assert.equal(
									(yield* Effect.flip(
										(yield* DeveloperMonitor).prepare({
											kind: "Proof",
											id: proof.id,
										}),
									))._tag,
									"SchemaError",
								)
								yield* db
									.update(developerProofs)
									.set({
										scope: stored.scope,
										nextVerificationAt: stored.nextVerificationAt,
									})
									.where(where)
							}),
						)
						// A broken old flow must fail before the exchange is submitted.
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
							Effect.flatMap(TestCommands.TestCommands, (commands) =>
								commands.exchange(
									{
										kind: "member",
										organizationId: "developer",
										userId: "alice",
									},
									exchanging.id,
									Execution.CommandKey.make("bad-exchange"),
								),
							).pipe(Effect.flip),
						)
						assert.strictEqual(completion._tag, "DeveloperConflict")
						const afterCut = yield* run(get(owner, exchanging.id))
						assert.strictEqual(afterCut.status, "AwaitingAuthorization")
						assert.strictEqual(afterCut.authorization?.status, "Received")
						assert.isNull(afterCut.reason)
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
						assert.strictEqual(restored.value.status, "Running")
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
						yield* run(cleanupTest(remembered))
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
