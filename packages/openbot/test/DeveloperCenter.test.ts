import { memberOf } from "./Caller.ts"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import * as Client from "@openbot-build/client"
import {
	AccountAuth,
	BotAuth,
	DeveloperApi as Api,
	SessionAuth,
} from "@openbot-build/api"
import {
	Array as Arr,
	Crypto,
	Effect,
	Formatter,
	Layer,
	Option,
	pipe,
	Redacted,
	Schedule,
	String as Str,
} from "effect"
import { PgClient } from "@effect/sql-pg"
import {
	FetchHttpClient,
	Headers,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpServer,
} from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import * as Development from "../dist/Development.js"
import * as Database from "../src/database/DatabasePostgres.ts"
import { Scenarios } from "../src/app/DevelopmentScenarios.ts"
import { Publication } from "../src/app/DevelopmentApps.ts"
import { Business } from "../src/app/DevelopmentBusiness.ts"
import * as TestStoresLayer from "../src/apps/DeveloperTestStores.ts"
import { DeveloperTestStores } from "../src/apps/DeveloperTestStores.ts"
import { eq } from "drizzle-orm"
import * as Rows from "../src/apps/DeveloperRows.ts"
import { IndexNamespace } from "../src/apps/IndexNamespace.ts"
import {
	developerApps,
	developerNotices,
	developerProofs,
	developerSubscriptions,
} from "../src/database/Schema.ts"
import * as SecretsLayer from "../src/secrets/Secrets.ts"
import { DeveloperTests } from "../src/apps/DeveloperTests.ts"
import { Index } from "@openbot-build/protocol"
import { DeveloperMonitor } from "../src/apps/DeveloperMonitor.ts"
import { DeveloperIndexing } from "../src/apps/DeveloperIndexing.ts"
import { IndexWork } from "../src/apps/IndexWork.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Postgres from "./PostgresTest.ts"
import { signIn } from "./DevelopmentLogin.ts"
import { OpenBot } from "@openbot-build/openbot"
import { Settings } from "../src/settings/Settings.ts"
import * as Db from "../src/database/Database.ts"

const cardUrl = "https://app.development.test/card.json"

/**
 * The client middleware of a browser. The browser sends the session Cookie
 * itself, so the middleware does not change the request.
 */
const browserMiddleware = Layer.mergeAll(
	HttpApiMiddleware.layerClient(BotAuth, ({ request, next }) => next(request)),
	HttpApiMiddleware.layerClient(AccountAuth, ({ request, next }) =>
		next(request),
	),
	HttpApiMiddleware.layerClient(SessionAuth, ({ request, next }) =>
		next(request),
	),
)

/** Gives a redirect back as the answer, in place of following it. */
const manualRedirect = Effect.provideService(FetchHttpClient.RequestInit, {
	redirect: "manual",
})

// The test talks to real servers, so it uses the real clock.
it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"standard developer clients finish publication, proof, history, test OAuth, indexing, notifications and cleanup",
		() =>
			Effect.gen(function* () {
				const crypto = yield* Crypto.Crypto
				const database = yield* Postgres.start
				const options = {
					host: "127.0.0.1",
					port: 0,
					databaseUrl: Redacted.make(database.url),
					secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
					auth: {
						mode: "development" as const,
						publicOrigin: "https://localhost:8443",
						secret: Redacted.make(
							"DeveloperCenterIntegrationSecretStable123456789",
						),
					},
				}
				const migration = yield* Layer.build(Database.layer(options))
				yield* Effect.provide(Database.migrate, migration)
				const sql = (statement: string) =>
					Effect.provide(
						Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe(statement)),
						migration,
					)
				/** The Developer test stores on new connections, as after a restart. */
				const freshStores = TestStoresLayer.layer.pipe(
					Layer.provide(Layer.succeed(IndexNamespace, "development")),
					Layer.provide(SecretsLayer.layer(options.secretKeys)),
					Layer.provide(Database.layer(options)),
				)
				/** Starts the development server. It stops when the scope closes. */
				const startServer = Effect.map(
					Layer.build(Development.layer(options)),
					(server) => Effect.provide(server),
				)

				const { owner, protectedTest, notice, pendingAtRestart } =
					yield* Effect.scoped(
						Effect.gen(function* () {
							const onServer = yield* startServer
							const address = yield* onServer(
								Effect.map(HttpServer.HttpServer, (server) =>
									HttpServer.formatAddress(server.address),
								),
							)
							const { cookie, send } = yield* signIn(
								address,
								options.auth.publicOrigin,
							)
							const headers = { cookie, origin: options.auth.publicOrigin }
							assert.strictEqual(
								(yield* HttpClient.get(address + "/v1/developer")).status,
								401,
							)
							assert.strictEqual(
								(yield* HttpClientRequest.post(
									address + "/v1/developer/claims",
									{ headers: { cookie } },
								).pipe(
									HttpClientRequest.bodyJson({ _tag: "AppCard", cardUrl }),
									Effect.flatMap(HttpClient.execute),
								)).status,
								403,
							)
							const { api } = yield* Client.make({ baseUrl: address }).pipe(
								Effect.provide([
									browserMiddleware,
									Layer.effect(
										HttpClient.HttpClient,
										Effect.map(
											HttpClient.HttpClient,
											HttpClient.mapRequest(
												HttpClientRequest.setHeaders(headers),
											),
										),
									),
								]),
							)
							const mode = (
								value: Parameters<typeof Scenarios.Service.set>[0],
							) =>
								onServer(
									Effect.flatMap(Scenarios, (scenarios) =>
										scenarios.set(value),
									),
								)
							const publication = (
								value: Parameters<typeof Publication.Service.set>[0],
							) =>
								onServer(
									Effect.flatMap(Publication, (publication) =>
										publication.set(value),
									),
								)
							const publishProof = Effect.fn("DeveloperCenter.publishProof")(
								function* (
									scope: Api.ManagementScope,
									tokens: ReadonlyArray<string>,
								) {
									const response = yield* send(
										"/development/apps/proofs",
										"POST",
										{ scope, tokens },
									)
									assert.strictEqual(response.status, 204, yield* response.text)
								},
							)
							const report = yield* api.developerPublic.inspect({
								payload: { input: "app.development.test" },
							})
							assert.strictEqual(report.apps[0]?.eligibility._tag, "Eligible")
							assert.ok(
								Arr.some(
									report.stages,
									(stage) =>
										stage.name === "PublisherAssociation" &&
										stage.status === "Passed",
								),
							)
							assert.deepStrictEqual(
								yield* api.connections.listConnections({}),
								[],
							)
							const claim = yield* api.developer.startClaim({
								payload: { _tag: "AppCard", cardUrl },
							})
							const mismatch = yield* Effect.flip(
								api.developer.verifyClaim({ params: { id: claim.id } }),
							)
							assert.strictEqual(mismatch._tag, "DeveloperConflict")
							yield* publishProof(claim.scope, [claim.token])
							const proof = yield* api.developer.verifyClaim({
								params: { id: claim.id },
							})
							assert.strictEqual(proof.status, "Confirmed")
							const domain = yield* api.developer.startClaim({
								payload: {
									_tag: "PublisherHostname",
									hostname: "app.development.test",
								},
							})
							yield* publishProof(domain.scope, [domain.token])
							yield* api.developer.verifyClaim({ params: { id: domain.id } })
							assert.strictEqual(
								(yield* api.developer.overview({})).proofs.length,
								2,
							)
							const invitation = yield* api.developer.invite({
								params: { id: proof.id },
								payload: { role: "viewer" },
							})
							yield* api.developer.invitation({
								params: { id: invitation.id },
							})
							assert.strictEqual(
								(yield* api.developer.members({ params: { id: proof.id } }))
									.members.length,
								0,
							)
							yield* api.developer.acceptInvitation({
								params: { id: invitation.id },
							})
							assert.strictEqual(
								(yield* api.developer.members({ params: { id: proof.id } }))
									.members.length,
								1,
							)
							yield* mode("requirements-changed")
							yield* api.developer.saveInspection({ payload: { cardUrl } })
							assert.strictEqual(
								(yield* api.developer.overview({})).apps[0]?.candidate
									.endpoints[0]?.remote.url,
								"https://app.development.test/mcp-updated",
							)
							yield* mode("available")

							const before = yield* api.developer.saveInspection({
								payload: { cardUrl },
							})
							yield* publication("noindex")
							const broken = yield* api.developer.saveInspection({
								payload: { cardUrl },
							})
							assert.ok(
								Arr.some(
									(yield* api.developer.compare({
										params: { id: before.id },
										query: { other: broken.id },
									})).introduced,
									(issue) => issue.code === "NoIndex",
								),
							)
							yield* publication("published")
							const plain = yield* api.developer.createTest({
								payload: {
									id: yield* crypto.randomUUIDv4(),
									cardUrl,
									remoteIndex: 0,
								},
							})
							assert.strictEqual(plain.status, "Queued")
							const settle = Effect.fn("DeveloperCenter.settle")(function* (
								id: string,
							) {
								const current = yield* api.developer
									.test({ params: { id } })
									.pipe(
										Effect.repeat({
											until: (test) => test.status !== "Running",
											schedule: Schedule.spaced("20 millis"),
											times: 100,
										}),
									)
								assert.notStrictEqual(
									current.status,
									"Running",
									Formatter.format(current),
								)
								return current
							})
							yield* api.developer.runTest({ params: { id: plain.id } })
							const completed = yield* settle(plain.id)
							assert.strictEqual(
								completed.status,
								"Succeeded",
								Formatter.format(completed),
							)
							assert.deepStrictEqual(
								pipe(
									Arr.findFirst(
										completed.stages,
										(stage) => stage.name === "tools",
									),
									Option.map((tools) => tools.items.length),
								),
								Option.some(2),
							)
							assert.deepStrictEqual(
								yield* api.connections.listConnections({}),
								[],
							)
							const protectedTest = yield* api.developer.createTest({
								payload: {
									id: yield* crypto.randomUUIDv4(),
									cardUrl,
									remoteIndex: 1,
								},
							})
							yield* api.developer.runTest({
								params: { id: protectedTest.id },
							})
							assert.strictEqual(
								(yield* settle(protectedTest.id)).status,
								"AwaitingAuthorization",
							)
							const started = yield* api.developer.authorizeTest({
								params: { id: protectedTest.id },
								payload: { scopes: ["documents"] },
							})
							assert.notStrictEqual(started.authorization, null)
							const authorizationUrl = new URL(
								started.authorization?.authorizationUrl ?? "",
							)
							assert.strictEqual(
								authorizationUrl.searchParams.get("redirect_uri"),
								options.auth.publicOrigin + "/auth/developer/apps/callback",
							)
							const consent = yield* manualRedirect(
								HttpClient.post(address + "/development/apps/authorize", {
									body: HttpBody.urlParams({
										query: Str.slice(1)(authorizationUrl.search),
										decision: "allow",
									}),
								}),
							)
							assert.strictEqual(consent.status, 303)
							const callback = new URL(
								yield* Effect.fromOption(
									Headers.get(consent.headers, "location"),
								),
							)
							assert.strictEqual(
								(yield* manualRedirect(
									send("/auth/apps/callback" + callback.search, "GET"),
								)).status,
								404,
							)
							const identity = yield* api.account.session({})
							const owner = ownerKey(yield* memberOf(identity))
							const wrongOwner = yield* onServer(
								Effect.flatMap(DeveloperTests, (tests) =>
									tests.receive(
										callback.toString(),
										Option.some([
											ownerKey({
												organizationId: "another",
												userId: "another",
											}),
										]),
									),
								).pipe(Effect.flip),
							)
							assert.strictEqual(wrongOwner._tag, "DeveloperNotFound")
							const badIssuer = new URL(callback)
							badIssuer.searchParams.set("iss", "https://wrong-issuer.example")
							assert.strictEqual(
								(yield* manualRedirect(
									send(badIssuer.pathname + badIssuer.search, "GET"),
								)).status,
								409,
							)
							const flowId = started.authorization?.flowId ?? ""
							const flow = yield* Effect.flatMap(
								DeveloperTestStores,
								(stores) =>
									stores.bind(owner, protectedTest.id).flows.get({
										key: { owner, connectionId: protectedTest.id },
										flowId,
									}),
							).pipe(Effect.provide(freshStores))
							assert.ok(Redacted.value(flow.verifier).length >= 43)
							assert.strictEqual(
								flow.binding.resource,
								"https://app.development.test/protected",
							)

							const receipt = yield* manualRedirect(
								send(callback.pathname + callback.search, "GET"),
							)
							assert.strictEqual(receipt.status, 303, yield* receipt.text)
							assert.deepStrictEqual(
								Headers.get(receipt.headers, "location"),
								Option.some(
									"/?" +
										new URLSearchParams({ developerTest: protectedTest.id }),
								),
							)
							assert.strictEqual(
								(yield* manualRedirect(
									send(callback.pathname + callback.search, "GET"),
								)).status,
								409,
							)

							assert.strictEqual(
								(yield* api.developer.test({
									params: { id: protectedTest.id },
								})).authorization?.status,
								"Received",
							)
							assert.strictEqual(
								(yield* api.developer.completeTestAuthorization({
									params: { id: protectedTest.id },
								})).authorization?.status,
								"Succeeded",
							)
							yield* Effect.gen(function* () {
								const stores = (yield* DeveloperTestStores).bind(
									owner,
									protectedTest.id,
								)
								const connection = yield* stores.apps.get({
									owner,
									connectionId: protectedTest.id,
								})
								assert.ok(connection.authorization._tag === "Authorized")
								const credential = yield* stores.credentials.get({
									binding: connection.authorization.binding,
									reference: connection.authorization.credentialRef,
								})
								assert.ok(Redacted.value(credential.accessToken).length > 0)
								assert.ok(
									credential.refreshToken !== undefined &&
										Redacted.value(credential.refreshToken).length > 0,
								)
								assert.deepStrictEqual(credential.scopes, ["documents"])
							}).pipe(Effect.provide(freshStores))

							const replay = yield* Effect.flip(
								api.developer.completeTestAuthorization({
									params: { id: protectedTest.id },
								}),
							)
							assert.ok(replay._tag === "DeveloperConflict")
							assert.strictEqual(replay.reason, "AuthorizationNotReceived")

							yield* api.developer.runTest({
								params: { id: protectedTest.id },
							})
							assert.strictEqual(
								(yield* settle(protectedTest.id)).status,
								"Succeeded",
							)
							const account = ownerKey(
								yield* memberOf(yield* api.account.session({})),
							)
							assert.strictEqual(
								yield* onServer(
									Effect.flatMap(Business, (business) =>
										business.executions(account),
									),
								),
								0,
							)
							yield* mode("cleanup-failure")
							assert.strictEqual(
								(yield* api.developer.cleanupTest({
									params: { id: protectedTest.id },
								})).cleanup,
								"Pending",
							)
							yield* mode("available")
							assert.strictEqual(
								(yield* api.developer.cleanupTest({
									params: { id: protectedTest.id },
								})).cleanup,
								"Complete",
							)
							yield* onServer(
								Effect.flatMap(Index.IndexStore, (index) =>
									index.withdraw(cardUrl),
								),
							)
							const request = yield* api.developer.requestIndexing({
								payload: { cardUrl },
							})
							assert.strictEqual(request.check, null)
							assert.strictEqual(
								(yield* api.developer.requestIndexing({ payload: { cardUrl } }))
									.id,
								request.id,
							)
							yield* onServer(
								Effect.flatMap(IndexWork, (work) => work.runOne(cardUrl)),
							)
							assert.strictEqual(
								(yield* api.developer.indexingRequest({
									params: { id: request.id },
								})).check?._tag,
								"Indexed",
							)
							assert.ok(
								Option.isSome(
									yield* onServer(
										Effect.flatMap(Index.IndexStore, (index) =>
											index.get(cardUrl),
										),
									),
								),
							)
							const jobs = sql(
								"SELECT generation, completed_generation, sources, requested_at FROM openbot_app_index_jobs WHERE namespace = 'development'",
							)
							const jobsBefore = yield* jobs
							yield* Effect.acquireUseRelease(
								Effect.andThen(
									sql(
										"CREATE FUNCTION reject_developer_request() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture write failure''; END'",
									),
									sql(
										"CREATE TRIGGER reject_developer_request BEFORE INSERT ON openbot_developer_index_requests FOR EACH ROW EXECUTE FUNCTION reject_developer_request()",
									),
								),
								() =>
									Effect.gen(function* () {
										const rejected = yield* Effect.flip(
											api.developer.requestIndexing({ payload: { cardUrl } }),
										)
										assert.strictEqual(rejected._tag, "DeveloperUnavailable")
										assert.deepStrictEqual(yield* jobs, jobsBefore)
									}),
								() =>
									Effect.asVoid(
										Effect.andThen(
											sql(
												"DROP TRIGGER reject_developer_request ON openbot_developer_index_requests",
											),
											sql("DROP FUNCTION reject_developer_request()"),
										),
									),
							)

							const next = yield* api.developer.requestIndexing({
								payload: { cardUrl },
							})
							assert.notStrictEqual(next.generation, request.generation)
							assert.strictEqual(next.check, null)
							yield* publication("noindex")
							yield* onServer(
								Effect.flatMap(IndexWork, (work) => work.runOne(cardUrl)),
							)
							assert.strictEqual(
								(yield* api.developer.indexingRequest({
									params: { id: next.id },
								})).check?._tag,
								"Withdrawn",
							)
							// Make the App due for its next monitor check.
							const dueNow = Effect.flatMap(Db.make, (db) =>
								db
									.update(developerApps)
									.set({ nextCheckAt: 0 })
									.where(eq(developerApps.cardUrl, cardUrl)),
							)
							const monitor = onServer(
								Effect.gen(function* () {
									yield* dueNow
									yield* (yield* DeveloperMonitor).run
								}),
							)
							yield* monitor
							const notices = yield* api.developer.notifications({
								query: {},
							})
							assert.strictEqual(
								Arr.filter(notices, (notice) => notice.kind === "IssueAppeared")
									.length,
								1,
							)
							yield* monitor
							assert.strictEqual(
								(yield* api.developer.notifications({ query: {} })).length,
								notices.length,
							)
							yield* publication("published")
							yield* monitor
							const recovered = yield* api.developer.notifications({
								query: {},
							})
							assert.strictEqual(
								Arr.filter(
									recovered,
									(notice) => notice.kind === "IssueResolved",
								).length,
								1,
							)
							const notice = recovered[0]
							assert.ok(notice !== undefined)
							yield* api.developer.readNotification({
								params: { id: notice.id },
							})
							yield* api.developer.subscribe({
								payload: { cardUrl, enabled: false },
							})
							yield* publication("noindex")
							yield* monitor
							assert.strictEqual(
								(yield* api.developer.notifications({ query: {} })).length,
								recovered.length,
							)
							yield* api.appExperience.reset({})
							assert.strictEqual(
								(yield* api.developer.overview({})).proofs.length,
								2,
							)
							assert.strictEqual(
								(yield* api.developer.test({ params: { id: plain.id } }))
									.status,
								"Succeeded",
							)
							yield* api.developer.cleanupTest({ params: { id: plain.id } })
							yield* api.developer.deleteTest({ params: { id: plain.id } })
							yield* publication("published")
							const pendingAtRestart = yield* api.developer.requestIndexing({
								payload: { cardUrl },
							})
							yield* onServer(dueNow)
							return { owner, protectedTest, notice, pendingAtRestart }
						}),
					)

				const restriction = {
					cardUrl,
					reason: "Fixture deployment restriction.",
					appealUrl: "https://publisher.example/appeal",
				}
				// The platform owns App restrictions. Write them while OpenBot is stopped.
				yield* Effect.gen(function* () {
					const settings = yield* Settings
					const current = yield* Effect.fromOption(yield* settings.platform)
					yield* settings.updatePlatform(current.version, (document) =>
						Effect.succeed({ ...document, appRestrictions: [restriction] }),
					)
				}).pipe(Effect.provide(OpenBot.layerShared(options)))

				yield* Effect.scoped(
					Effect.gen(function* () {
						const onServer = yield* startServer
						yield* onServer(
							Effect.flatMap(IndexWork, (work) => work.runOne(cardUrl)),
						)
						// The startup worker may take the job before this test calls runOne.
						const restrictedRequest = yield* onServer(
							Effect.flatMap(DeveloperIndexing, (indexing) =>
								indexing.get(owner, pendingAtRestart.id),
							).pipe(
								Effect.repeat({
									until: (request) => request.status === "Completed",
									schedule: Schedule.spaced("10 millis"),
									times: 100,
								}),
							),
						)
						assert.strictEqual(restrictedRequest.check?._tag, "Excluded")
						assert.deepStrictEqual(restrictedRequest.restriction, restriction)
						const restricted = yield* onServer(
							Effect.flatMap(DeveloperIndexing, (indexing) =>
								indexing.request(owner, cardUrl),
							).pipe(Effect.flip),
						)
						assert.ok(restricted._tag === "DeveloperRestricted")
						assert.strictEqual(
							restricted.restriction.appealUrl,
							restriction.appealUrl,
						)
						const restartedApp = yield* onServer(
							Effect.flatMap(Db.make, (db) =>
								Rows.getApp(db, "development", cardUrl),
							).pipe(
								Effect.repeat({
									until: (app) => app.nextCheckAt !== 0,
									schedule: Schedule.spaced("10 millis"),
									times: 100,
								}),
							),
						)
						assert.ok(restartedApp.nextCheckAt > 0)

						assert.strictEqual(
							(yield* onServer(
								Effect.flatMap(Db.make, (db) =>
									Rows.getTest(db, "development", protectedTest.id),
								),
							)).value.status,
							"Cancelled",
						)
						assert.strictEqual(
							(yield* onServer(
								Effect.flatMap(Db.make, (db) =>
									db
										.select()
										.from(developerProofs)
										.where(eq(developerProofs.namespace, "development")),
								),
							)).length,
							2,
						)
						const persistedNotices = yield* onServer(
							Effect.flatMap(Db.make, (db) =>
								db.select().from(developerNotices),
							),
						)
						assert.ok(
							Arr.some(
								persistedNotices,
								(row) => row.id === notice.id && row.readAt !== null,
							),
						)
						const persistedSubscriptions = yield* onServer(
							Effect.flatMap(Db.make, (db) =>
								db.select().from(developerSubscriptions),
							),
						)
						assert.ok(
							Arr.some(
								persistedSubscriptions,
								(row) => row.cardUrl === cardUrl && row.enabled === false,
							),
						)
					}),
				)
			}),
		{ timeout: 60000 },
	)
})
