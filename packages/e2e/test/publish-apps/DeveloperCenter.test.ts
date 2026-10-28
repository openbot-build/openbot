import { Execution } from "@openbot-build/domain"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import * as Client from "@openbot-build/client"
import {
	AccountAuth,
	AuthApi,
	BotAuth,
	DeveloperApi as Api,
	SessionAuth,
} from "@openbot-build/api"
import {
	Array as Arr,
	Crypto,
	Effect,
	Fiber,
	Formatter,
	Layer,
	Option,
	pipe,
	Redacted,
	Schedule,
	Stream,
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
import * as Development from "@openbot-build/openbot/Development"
import { DatabasePostgres as Database, OpenBot } from "@openbot-build/openbot"
import { Index } from "@openbot-build/protocol"
import {
	Caller,
	DevelopmentLogin,
	DevelopmentTesting,
	DeveloperTesting,
	PostgresTest as Postgres,
	Wait,
} from "@openbot-build/openbot/testing"

const { memberOf } = Caller
const { signIn } = DevelopmentLogin
const { ownerForMember: ownerKey } = DeveloperTesting

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
					clusterSecret: Redacted.make(
						"test-cluster-secret-with-at-least-32-characters",
					),
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
				/** Starts the development server. It stops when the scope closes. */
				const startServer = Effect.map(
					Layer.build(Development.layer(options)),
					(server) => Effect.provide(server),
				)

				const { owner, actor, protectedTest, notice, pendingAtRestart } =
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
							const browserClient = (requestHeaders: Headers.Input) =>
								Client.make({ baseUrl: address }).pipe(
									Effect.provide([
										browserMiddleware,
										Layer.effect(
											HttpClient.HttpClient,
											Effect.map(
												HttpClient.HttpClient,
												HttpClient.mapRequest(
													HttpClientRequest.setHeaders(requestHeaders),
												),
											),
										),
									]),
								)
							const { api } = yield* browserClient(headers)
							assert.deepStrictEqual(
								yield* api.developer.personalReports({ query: {} }),
								[],
							)
							assert.deepStrictEqual(
								yield* api.developer.indexingRequests({ query: {} }),
								[],
							)

							const mode = (
								value: Parameters<typeof DevelopmentTesting.setScenario>[0],
							) => onServer(DevelopmentTesting.setScenario(value))
							const publication = (
								value: Parameters<typeof DeveloperTesting.setPublication>[0],
							) => onServer(DeveloperTesting.setPublication(value))
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
							const verify = (id: string, key: string) =>
								api.developer.verifyClaim({
									params: { id },
									payload: { commandKey: Execution.CommandKey.make(key) },
								})
							const settled = (executionId: Execution.Id) =>
								Wait.untilTrue(
									"Execution result",
									api.executions.get({ params: { executionId } }),
									(record) => Execution.isTerminal(record.status),
								)
							const mismatch = yield* settled(
								(yield* verify(claim.id, "missing-proof")).executionId,
							)
							assert.strictEqual(mismatch.status, "failed")
							assert.strictEqual(mismatch.failure?.category, "conflict")
							yield* publishProof(claim.scope, [claim.token])
							const accepted = yield* verify(claim.id, "matched-proof")
							assert.equal(
								(yield* verify(claim.id, "matched-proof")).executionId,
								accepted.executionId,
							)
							assert.equal(
								(yield* settled(accepted.executionId)).status,
								"completed",
							)
							const proof = yield* api.developer.getProof({
								params: { id: claim.id },
							})
							const proofScope = yield* onServer(
								Effect.gen(function* () {
									const sql = yield* PgClient.PgClient
									const rows = yield* sql<{
										scope: string
									}>`select scope from openbot_developer_proofs where id = ${proof.id}`
									yield* sql`update openbot_developer_proofs set scope = 'private-broken-proof' where id = ${proof.id}`
									return rows[0]!.scope
								}),
							)
							const unreadable = yield* api.developer
								.overview({})
								.pipe(Effect.flip)
							assert.ok(unreadable._tag === "RequestFailed")
							assert.equal(unreadable.category, "unavailable")
							assert.notInclude(
								Formatter.format(unreadable),
								"private-broken-proof",
							)
							const failure = yield* DeveloperTesting.readFailure(
								options,
								unreadable.errorId,
							)
							assert.notInclude(failure.sealed, "private-broken-proof")
							assert.include(failure.details, "SchemaError")
							assert.include(failure.details, "Expected a valid JSON string")
							assert.include(failure.details, "DeveloperAccess.grants")
							yield* onServer(
								Effect.gen(function* () {
									const sql = yield* PgClient.PgClient
									yield* sql`update openbot_developer_proofs set scope = ${proofScope} where id = ${proof.id}`
								}),
							)

							assert.strictEqual(proof.status, "Confirmed")
							const domain = yield* api.developer.startClaim({
								payload: {
									_tag: "PublisherHostname",
									hostname: "app.development.test",
								},
							})
							yield* publishProof(domain.scope, [domain.token])
							assert.equal(
								(yield* settled(
									(yield* verify(domain.id, "domain-proof")).executionId,
								)).status,
								"completed",
							)
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
							const changed = yield* api.developer.saveInspection({
								payload: { cardUrl },
							})
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
							const personalReports = yield* api.developer.personalReports({
								query: {},
							})
							assert.sameDeepMembers(
								Arr.fromIterable(personalReports),
								Arr.map([changed, before, broken], (saved) => ({
									id: saved.id,
									cardUrl: saved.cardUrl,
									checkedAt: saved.report.checkedAt,
								})),
							)
							assert.isTrue(
								Arr.every(
									Arr.zip(personalReports, Arr.drop(personalReports, 1)),
									([newer, older]) =>
										newer.checkedAt > older.checkedAt ||
										(newer.checkedAt === older.checkedAt &&
											newer.id > older.id),
								),
							)
							for (const [cursor, offset] of Arr.map(
								personalReports,
								(cursor, offset) => [cursor, offset] as const,
							)) {
								assert.deepStrictEqual(
									yield* api.developer.personalReports({
										query: { before: cursor.id },
									}),
									Arr.drop(personalReports, offset + 1),
								)
							}
							const missingCursor = yield* api.developer
								.personalReports({
									query: { before: "00000000-0000-4000-8000-000000000001" },
								})
								.pipe(Effect.flip)
							assert.strictEqual(missingCursor._tag, "DeveloperInputInvalid")
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
							yield* api.developer.runTest({
								params: { id: plain.id },
								payload: {
									commandKey: Execution.CommandKey.make("plain-test"),
								},
							})
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
								payload: {
									commandKey: Execution.CommandKey.make(
										yield* crypto.randomUUIDv4(),
									),
								},
								params: { id: protectedTest.id },
							})
							assert.strictEqual(
								(yield* settle(protectedTest.id)).status,
								"AwaitingAuthorization",
							)
							const authorizationCommand = yield* api.developer.authorizeTest({
								params: { id: protectedTest.id },
								payload: {
									commandKey: Execution.CommandKey.make(
										"prepare-test-authorization",
									),
									scopes: ["documents"],
								},
							})
							const authorizationExecution = yield* Wait.untilTrue(
								"Test authorization is ready",
								api.executions.get({
									params: { executionId: authorizationCommand.executionId },
								}),
								(record) => Execution.isTerminal(record.status),
							)
							assert.strictEqual(authorizationExecution.status, "completed")
							const started = yield* api.developer.test({
								params: { id: protectedTest.id },
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
								DeveloperTesting.receiveForOwners(callback.toString(), [
									ownerKey({ organizationId: "another", userId: "another" }),
								]).pipe(Effect.flip),
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
							const flow = yield* DeveloperTesting.readStoredFlow(
								options,
								owner,
								protectedTest.id,
								flowId,
							)
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
							const completeAuthorization =
								api.developer.completeTestAuthorization({
									params: { id: protectedTest.id },
									payload: {
										commandKey: Execution.CommandKey.make(
											"complete-test-authorization",
										),
									},
								})
							const completion = yield* completeAuthorization
							const completionEnd = yield* Effect.fromOption(
								yield* Stream.unwrap(
									api.executions.observe({
										params: { executionId: completion.executionId },
										query: { afterSequence: 0 },
									}),
								).pipe(Stream.runLast),
							)
							assert.deepStrictEqual(completionEnd.data.body, {
								_tag: "State",
								status: "completed",
								failure: null,
							})
							const authorizedTest = yield* api.developer.test({
								params: { id: protectedTest.id },
							})
							assert.strictEqual(
								authorizedTest.executionId,
								completion.executionId,
							)
							assert.strictEqual(
								authorizedTest.authorization?.status,
								"Succeeded",
							)
							const storedAuthorization =
								yield* DeveloperTesting.readStoredAuthorization(
									options,
									owner,
									protectedTest.id,
								)
							assert.ok(storedAuthorization.authorization._tag === "Authorized")
							const credential = storedAuthorization.credential
							assert.ok(credential !== null)
							assert.ok(Redacted.value(credential.accessToken).length > 0)
							assert.ok(
								credential.refreshToken !== undefined &&
									Redacted.value(credential.refreshToken).length > 0,
							)
							assert.deepStrictEqual(credential.scopes, ["documents"])

							assert.deepStrictEqual(yield* completeAuthorization, completion)
							const replay = yield* Effect.flip(
								api.developer.completeTestAuthorization({
									params: { id: protectedTest.id },
									payload: {
										commandKey: Execution.CommandKey.make(
											"complete-test-authorization-again",
										),
									},
								}),
							)
							assert.ok(replay._tag === "DeveloperConflict")
							assert.strictEqual(replay.reason, "AuthorizationNotReceived")

							yield* api.developer.runTest({
								payload: {
									commandKey: Execution.CommandKey.make(
										yield* crypto.randomUUIDv4(),
									),
								},
								params: { id: protectedTest.id },
							})
							assert.strictEqual(
								(yield* settle(protectedTest.id)).status,
								"Succeeded",
							)
							const account = yield* memberOf(yield* api.account.session({}))
							assert.strictEqual(
								yield* onServer(DevelopmentTesting.executionCount(account)),
								0,
							)
							yield* mode("cleanup-failure")
							const cleanupKey = Execution.CommandKey.make(
								"cleanup-protected-test",
							)
							const cleanup = yield* api.developer.cleanupTest({
								params: { id: protectedTest.id },
								payload: { commandKey: cleanupKey },
							})
							const grants = yield* Wait.untilTrue(
								"The shared grant cleanup starts",
								api.executions.events({
									params: { executionId: cleanup.executionId },
									query: { afterSequence: 0 },
								}),
								(page) =>
									Arr.some(
										page.events,
										(event) =>
											event.body._tag === "Checkpoint" &&
											event.body.resource.kind === "DeveloperTestGrantCleanup",
									),
							)
							const grantExecutions = Arr.flatMap(grants.events, (event) =>
								event.body._tag === "Checkpoint" &&
								event.body.resource.kind === "DeveloperTestGrantCleanup"
									? [Execution.Id.make(event.body.resource.id)]
									: [],
							)
							yield* Wait.untilTrue(
								"The failed cleanup call is saved",
								Effect.forEach(grantExecutions, (executionId) =>
									api.executions.events({
										params: { executionId },
										query: { afterSequence: 0 },
									}),
								),
								(pages) =>
									Arr.some(pages, (page) =>
										Arr.some(
											page.events,
											(event) =>
												event.body._tag === "StepCompleted" &&
												event.body.step === "revoke",
										),
									),
							)

							assert.strictEqual(
								(yield* api.developer.test({
									params: { id: protectedTest.id },
								})).cleanup,
								"Pending",
							)
							yield* mode("available")
							assert.strictEqual(
								(yield* api.developer.cleanupTest({
									params: { id: protectedTest.id },
									payload: { commandKey: cleanupKey },
								})).executionId,
								cleanup.executionId,
							)
							assert.strictEqual(
								(yield* settled(cleanup.executionId)).status,
								"completed",
							)
							assert.strictEqual(
								(yield* api.developer.test({
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
								payload: {
									cardUrl,
									commandKey: Execution.CommandKey.make("first-index"),
								},
							})
							assert.strictEqual(
								(yield* api.developer.requestIndexing({
									payload: {
										cardUrl,
										commandKey: Execution.CommandKey.make("first-index"),
									},
								})).id,
								request.id,
							)
							yield* Wait.untilTrue(
								"Index request result",
								api.executions.get({
									params: { executionId: request.executionId },
								}),
								(record) => Execution.isTerminal(record.status),
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
							const firstRequests = yield* api.developer.indexingRequests({
								query: {},
							})
							assert.deepStrictEqual(
								Arr.map(firstRequests, (item) => item.id),
								[request.id],
							)
							assert.strictEqual(firstRequests[0]?.check?._tag, "Indexed")
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
											api.developer.requestIndexing({
												payload: {
													cardUrl,
													commandKey:
														Execution.CommandKey.make("rejected-index"),
												},
											}),
										)
										assert.ok(rejected._tag === "RequestFailed")
										assert.equal(rejected.category, "unavailable")
										assert.notInclude(
											Formatter.format(rejected),
											"fixture write failure",
										)
										const failure = yield* DeveloperTesting.readFailure(
											options,
											rejected.errorId,
										)
										assert.notInclude(failure.sealed, "fixture write failure")
										assert.include(failure.details, "fixture write failure")
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

							yield* publication("noindex")
							const next = yield* api.developer.requestIndexing({
								payload: {
									cardUrl,
									commandKey: Execution.CommandKey.make("next-index"),
								},
							})
							assert.notStrictEqual(next.generation, request.generation)
							yield* Wait.untilTrue(
								"Index request result",
								api.executions.get({
									params: { executionId: next.executionId },
								}),
								(record) => Execution.isTerminal(record.status),
							)
							assert.strictEqual(
								(yield* api.developer.indexingRequest({
									params: { id: next.id },
								})).check?._tag,
								"Withdrawn",
							)
							const requests = yield* api.developer.indexingRequests({
								query: {},
							})
							assert.sameDeepMembers(
								Arr.map(requests, (item) => ({
									id: item.id,
									generation: item.generation,
									executionId: item.executionId,
								})),
								Arr.map([request, next], (item) => ({
									id: item.id,
									generation: item.generation,
									executionId: item.executionId,
								})),
							)
							assert.deepStrictEqual(
								yield* api.developer.indexingRequests({ query: { cardUrl } }),
								requests,
							)
							// A durable signal asks the shared monitor for a fresh check.
							const monitor = onServer(DeveloperTesting.checkApp(cardUrl))
							const watchKey = yield* onServer(
								Effect.gen(function* () {
									const sql = yield* PgClient.PgClient
									yield* sql`create function reject_monitor_notice() returns trigger language plpgsql as $$ begin raise exception 'Fixture monitor notice write failure'; end $$`
									yield* sql`create trigger reject_monitor_notice before insert on openbot_developer_notices for each row execute function reject_monitor_notice()`
									return yield* DeveloperTesting.ensureAppWatch(cardUrl)
								}),
							)
							const checking = yield* Effect.forkScoped(monitor)
							yield* onServer(
								Effect.gen(function* () {
									const sql = yield* PgClient.PgClient
									yield* Wait.untilTrue(
										"a saved check and failed state write",
										sql<{ ready: boolean }>`
         select exists(select 1 from openbot_execution_calls where execution_id = ${watchKey.id} and status = 'completed')
          and exists(select 1 from openbot_execution_failures where execution_id = ${watchKey.id}) as ready
        `,
										(rows) => rows[0]?.ready === true,
									)
									yield* sql`drop trigger reject_monitor_notice on openbot_developer_notices`
									yield* sql`drop function reject_monitor_notice()`
								}),
							)
							yield* Fiber.join(checking)
							yield* onServer(
								Effect.gen(function* () {
									const sql = yield* PgClient.PgClient
									const calls =
										yield* sql`select id from openbot_execution_calls where execution_id = ${watchKey.id}`
									assert.equal(calls.length, 1)
								}),
							)
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
							const reset = yield* api.appExperience.reset({
								payload: {
									commandKey: Execution.CommandKey.make("reset-apps"),
								},
							})
							assert.equal(
								(yield* settled(reset.executionId)).status,
								"completed",
							)
							assert.strictEqual(
								(yield* api.developer.overview({})).proofs.length,
								2,
							)
							assert.strictEqual(
								(yield* api.developer.test({ params: { id: plain.id } }))
									.status,
								"Succeeded",
							)
							const plainCleanup = yield* api.developer.cleanupTest({
								params: { id: plain.id },
								payload: {
									commandKey: Execution.CommandKey.make("cleanup-plain"),
								},
							})
							assert.strictEqual(
								(yield* settled(plainCleanup.executionId)).status,
								"completed",
							)
							const removed = yield* api.developer.deleteTest({
								params: { id: plain.id },
								query: {
									commandKey: Execution.CommandKey.make("remove-plain"),
								},
							})
							assert.strictEqual(
								(yield* settled(removed.executionId)).status,
								"completed",
							)
							const deleted = yield* Effect.flip(
								api.developer.test({ params: { id: plain.id } }),
							)
							assert.strictEqual(deleted._tag, "DeveloperNotFound")
							yield* publication("published")
							const pendingAtRestart = yield* api.developer.requestIndexing({
								payload: {
									cardUrl,
									commandKey: Execution.CommandKey.make("before-restart"),
								},
							})
							yield* onServer(DeveloperTesting.requestAppWatch(cardUrl))
							yield* Wait.untilTrue(
								"Index result before restart",
								api.executions.get({
									params: { executionId: pendingAtRestart.executionId },
								}),
								(record) => Execution.isTerminal(record.status),
							)
							const actor = yield* memberOf(yield* api.account.session({}))
							const allRequests = yield* api.developer.indexingRequests({
								query: {},
							})
							assert.sameMembers(
								Arr.map(allRequests, (item) => item.id),
								[request.id, next.id, pendingAtRestart.id],
							)
							const token = yield* api.userTokens.createToken({
								payload: { name: "Developer history" },
							})
							const { api: keyedApi } = yield* Client.Client.pipe(
								Effect.provide(
									Client.layer({ baseUrl: address, token: token.secret }),
								),
							)
							assert.deepStrictEqual(
								yield* keyedApi.developer.personalReports({ query: {} }),
								personalReports,
							)
							assert.deepStrictEqual(
								yield* keyedApi.developer.indexingRequests({
									query: { cardUrl },
								}),
								allRequests,
							)

							// A second organization has no reports or requests from the first one.
							const otherOrganization =
								yield* api.organizations.createOrganization({
									payload: { name: "Other publisher" },
								})
							const { api: otherApi } = yield* browserClient({
								...headers,
								[AuthApi.OrganizationHeader]: otherOrganization.id,
							})
							assert.deepStrictEqual(
								yield* otherApi.developer.personalReports({ query: {} }),
								[],
							)
							assert.deepStrictEqual(
								yield* otherApi.developer.indexingRequests({ query: {} }),
								[],
							)
							const foreignCursor = yield* otherApi.developer
								.personalReports({ query: { before: before.id } })
								.pipe(Effect.flip)
							assert.strictEqual(foreignCursor._tag, "DeveloperInputInvalid")
							const foreignRequests = yield* otherApi.developer
								.indexingRequests({ query: { cardUrl } })
								.pipe(Effect.flip)
							assert.strictEqual(foreignRequests._tag, "DeveloperNotFound")
							return { owner, actor, protectedTest, notice, pendingAtRestart }
						}),
					)

				const restriction = {
					cardUrl,
					reason: "Fixture deployment restriction.",
					appealUrl: "https://publisher.example/appeal",
				}
				// The platform owns App restrictions. Write them while OpenBot is stopped.
				yield* DeveloperTesting.writeRestrictions([restriction]).pipe(
					Effect.provide(OpenBot.layerShared(options)),
				)

				yield* Effect.scoped(
					Effect.gen(function* () {
						const onServer = yield* startServer
						// A restart keeps the completed request's result. The new check has its own generation.
						const check = yield* onServer(
							DeveloperTesting.requestIndexCheck(cardUrl),
						)
						yield* Wait.until(
							"new restriction check",
							onServer(
								DeveloperTesting.readIndexCheck(cardUrl, check.job.generation),
							).pipe(
								Effect.map(Option.filter((job) => job.status === "Completed")),
							),
						)
						const restrictedRequest = yield* onServer(
							DeveloperTesting.readIndexRequest(
								owner,
								pendingAtRestart.id,
							).pipe(
								Effect.repeat({
									until: (request) => request.status === "Completed",
									schedule: Schedule.spaced("10 millis"),
									times: 100,
								}),
							),
						)
						assert.strictEqual(restrictedRequest.check?._tag, "Indexed")
						assert.deepStrictEqual(restrictedRequest.restriction, restriction)
						const restricted = yield* onServer(
							DeveloperTesting.requestIndex(
								{ kind: "member", ...actor },
								cardUrl,
								Execution.CommandKey.make("restricted-index"),
							).pipe(Effect.flip),
						)
						assert.ok(restricted._tag === "DeveloperRestricted")
						assert.strictEqual(
							restricted.restriction.appealUrl,
							restriction.appealUrl,
						)
						const restartedApp = yield* onServer(
							DeveloperTesting.readSavedApp(cardUrl).pipe(
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
								DeveloperTesting.readSavedTest(protectedTest.id),
							)).value.status,
							"Cancelled",
						)
						assert.strictEqual(
							(yield* onServer(DeveloperTesting.readProofs)).length,
							2,
						)
						const persistedNotices = yield* onServer(
							DeveloperTesting.readNotices,
						)
						assert.ok(
							Arr.some(
								persistedNotices,
								(row) => row.id === notice.id && row.readAt !== null,
							),
						)
						const persistedSubscriptions = yield* onServer(
							DeveloperTesting.readSubscriptions,
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
