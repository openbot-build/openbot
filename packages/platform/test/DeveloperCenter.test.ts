// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import {
	Client,
	layer as clientLayer,
	type ClientError,
} from "@openbot-build/client"
import { AuthApi, DeveloperApi as Api } from "@openbot-build/platform-api"
import {
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Schedule,
} from "effect"
import { PgClient } from "@effect/sql-pg"
import { FetchHttpClient, HttpServer } from "effect/http"
import * as Development from "../dist/Development.js"
import * as Database from "../src/database/DatabasePostgres.ts"
import { Scenarios } from "../src/app/DevelopmentScenarios.ts"
import { Publication } from "../src/app/DevelopmentApps.ts"
import { Business } from "../src/app/DevelopmentBusiness.ts"
import * as TestStoresLayer from "../src/apps/DeveloperTestStores.ts"
import { DeveloperTestStores } from "../src/apps/DeveloperTestStores.ts"
import * as DeveloperRepositoryLayer from "../src/apps/DeveloperRepositoryPostgres.ts"
import * as SecretsLayer from "../src/apps/Secrets.ts"
import { DeveloperTests } from "../src/apps/DeveloperTests.ts"
import { DeveloperRepository } from "../src/apps/DeveloperRepository.ts"
import { DeveloperMonitor } from "../src/apps/DeveloperMonitor.ts"
import { IndexRepository } from "../src/apps/IndexRepository.ts"
import { DeveloperIndexing } from "../src/apps/DeveloperIndexing.ts"
import { IndexWork } from "../src/apps/IndexWork.ts"
import { ownerKey } from "../src/apps/Repository.ts"
import * as Postgres from "./PostgresTest.ts"

const cardUrl = "https://app.development.test/card.json"
test(
	"standard developer clients finish publication, proof, history, test OAuth, indexing, notifications and cleanup",
	{ timeout: 60000 },
	async () => {
		const database = await Postgres.start()
		const options = {
			host: "127.0.0.1",
			port: 0,
			databaseUrl: Redacted.make(database.url),
			appEncryptionKey: Redacted.make("11".repeat(32)),
			auth: {
				mode: "development" as const,
				publicOrigin: "https://localhost:8443",
				secret: Redacted.make(
					"DeveloperCenterIntegrationSecretStable123456789",
				),
			},
		}
		await using migration = ManagedRuntime.make(
			Database.layer(options).pipe(Layer.provide(NodeServices.layer)),
		)
		await migration.runPromise(Database.migrate)
		let server = ManagedRuntime.make(Development.layer(options))
		try {
			const address = await server.runPromise(
				Effect.map(HttpServer.HttpServer, (value) =>
					HttpServer.formatAddress(value.address),
				),
			)
			const login = await fetch(
				address +
					"/auth/login?returnTo=" +
					encodeURIComponent("/developer/tests/example"),
				{ redirect: "manual" },
			)
			assert.equal(
				login.headers.get("location"),
				options.auth.publicOrigin + "/developer/tests/example",
			)
			const cookie =
				login.headers
					.getSetCookie()
					.find((value) => value.startsWith(AuthApi.SessionCookie + "="))
					?.split(";")[0] ?? ""
			const headers = {
				cookie,
				origin: options.auth.publicOrigin,
				"content-type": "application/json",
			}
			assert.equal((await fetch(address + "/v1/developer")).status, 401)
			assert.equal(
				(
					await fetch(address + "/v1/developer/claims", {
						method: "POST",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ _tag: "AppCard", cardUrl }),
					})
				).status,
				403,
			)
			await using client = ManagedRuntime.make(
				clientLayer({ baseUrl: address }).pipe(
					Layer.provide(
						Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
							fetch(input, {
								...init,
								headers: {
									...Object.fromEntries(new Headers(init?.headers)),
									...headers,
								},
							}),
						),
					),
				),
			)
			const call = <A>(
				operation: (
					api: (typeof Client.Service)["api"],
				) => Effect.Effect<A, ClientError>,
			) =>
				client.runPromise(
					Effect.flatMap(Client, (value) => operation(value.api)),
				)
			const freshStores = () =>
				ManagedRuntime.make(
					TestStoresLayer.layer.pipe(
						Layer.provide(DeveloperRepositoryLayer.layerFor("development")),
						Layer.provide(SecretsLayer.layer(options.appEncryptionKey)),
						Layer.provide(Database.layer(options)),
						Layer.provide(NodeServices.layer),
					),
				)

			const sql = (statement: string) =>
				migration.runPromise(
					Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe(statement)),
				)
			const mode = (value: Parameters<typeof Scenarios.Service.set>[0]) =>
				server.runPromise(
					Effect.flatMap(Scenarios, (scenarios) => scenarios.set(value)),
				)
			const publication = (
				value: Parameters<typeof Publication.Service.set>[0],
			) =>
				server.runPromise(
					Effect.flatMap(Publication, (publication) => publication.set(value)),
				)
			const publishProof = async (
				scope: Api.ManagementScope,
				tokens: ReadonlyArray<string>,
			) => {
				const response = await fetch(address + "/development/apps/proofs", {
					method: "POST",
					headers,
					body: JSON.stringify({ scope, tokens }),
				})
				assert.equal(response.status, 204, await response.text())
			}
			const report = await call((api) =>
				api.developerPublic.inspect({
					payload: { input: "app.development.test" },
				}),
			)
			assert.equal(report.apps[0]?.eligibility._tag, "Eligible")
			assert.ok(
				report.stages.some(
					(stage) =>
						stage.name === "PublisherAssociation" && stage.status === "Passed",
				),
			)
			assert.deepEqual(
				await call((api) => api.connections.listConnections({})),
				[],
			)
			const claim = await call((api) =>
				api.developer.startClaim({ payload: { _tag: "AppCard", cardUrl } }),
			)
			const mismatch = await client.runPromise(
				Effect.flatMap(Client, (value) =>
					value.api.developer.verifyClaim({ params: { id: claim.id } }),
				).pipe(Effect.flip),
			)
			assert.equal(mismatch._tag, "DeveloperConflict")
			await publishProof(claim.scope, [claim.token])
			const proof = await call((api) =>
				api.developer.verifyClaim({ params: { id: claim.id } }),
			)
			assert.equal(proof.status, "Confirmed")
			const domain = await call((api) =>
				api.developer.startClaim({
					payload: {
						_tag: "PublisherHostname",
						hostname: "app.development.test",
					},
				}),
			)
			await publishProof(domain.scope, [domain.token])
			await call((api) =>
				api.developer.verifyClaim({ params: { id: domain.id } }),
			)
			assert.equal(
				(await call((api) => api.developer.overview({}))).proofs.length,
				2,
			)
			const invitation = await call((api) =>
				api.developer.invite({
					params: { id: proof.id },
					payload: { role: "viewer" },
				}),
			)
			await call((api) =>
				api.developer.invitation({ params: { id: invitation.id } }),
			)
			assert.equal(
				(
					await call((api) =>
						api.developer.members({ params: { id: proof.id } }),
					)
				).members.length,
				0,
			)
			await call((api) =>
				api.developer.acceptInvitation({ params: { id: invitation.id } }),
			)
			assert.equal(
				(
					await call((api) =>
						api.developer.members({ params: { id: proof.id } }),
					)
				).members.length,
				1,
			)
			await mode("requirements-changed")
			await call((api) =>
				api.developer.saveInspection({ payload: { cardUrl } }),
			)
			assert.equal(
				(await call((api) => api.developer.overview({}))).apps[0]?.candidate
					.endpoints[0]?.remote.url,
				"https://app.development.test/mcp-updated",
			)
			await mode("available")

			const before = await call((api) =>
				api.developer.saveInspection({ payload: { cardUrl } }),
			)
			await publication("noindex")
			const broken = await call((api) =>
				api.developer.saveInspection({ payload: { cardUrl } }),
			)
			assert.ok(
				(
					await call((api) =>
						api.developer.compare({
							params: { id: before.id },
							query: { other: broken.id },
						}),
					)
				).introduced.some((issue) => issue.code === "NoIndex"),
			)
			await publication("published")
			const plain = await call((api) =>
				api.developer.createTest({
					payload: { id: randomUUID(), cardUrl, remoteIndex: 0 },
				}),
			)
			assert.equal(plain.status, "Queued")
			const settle = async (id: string) => {
				let current = await call((api) =>
					api.developer.test({ params: { id } }),
				)
				for (
					let attempt = 0;
					current.status === "Running" && attempt < 100;
					attempt++
				) {
					await new Promise((resolve) => setTimeout(resolve, 20))
					current = await call((api) => api.developer.test({ params: { id } }))
				}
				assert.notEqual(current.status, "Running", JSON.stringify(current))
				return current
			}
			await call((api) => api.developer.runTest({ params: { id: plain.id } }))
			const completed = await settle(plain.id)
			assert.equal(completed.status, "Succeeded", JSON.stringify(completed))
			assert.equal(
				completed.stages.find((stage) => stage.name === "tools")?.items.length,
				2,
			)
			assert.deepEqual(
				await call((api) => api.connections.listConnections({})),
				[],
			)
			const protectedTest = await call((api) =>
				api.developer.createTest({
					payload: { id: randomUUID(), cardUrl, remoteIndex: 1 },
				}),
			)
			await call((api) =>
				api.developer.runTest({ params: { id: protectedTest.id } }),
			)
			assert.equal(
				(await settle(protectedTest.id)).status,
				"AwaitingAuthorization",
			)
			const started = await call((api) =>
				api.developer.authorizeTest({
					params: { id: protectedTest.id },
					payload: { scopes: ["documents"] },
				}),
			)
			assert.notEqual(started.authorization, null)
			const authorizationUrl = new URL(
				started.authorization?.authorizationUrl ?? "",
			)
			assert.equal(
				authorizationUrl.searchParams.get("redirect_uri"),
				options.auth.publicOrigin + "/auth/developer/apps/callback",
			)
			const consent = await fetch(address + "/development/apps/authorize", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					query: authorizationUrl.search.slice(1),
					decision: "allow",
				}),
				redirect: "manual",
			})
			assert.equal(consent.status, 303)
			const callback = new URL(consent.headers.get("location") ?? "")
			assert.equal(
				(
					await fetch(address + "/auth/apps/callback" + callback.search, {
						headers,
						redirect: "manual",
					})
				).status,
				404,
			)
			const identity = await call((api) => api.account.session({}))
			const owner = ownerKey(identity.identity)
			const wrongOwner = await server.runPromise(
				Effect.flatMap(DeveloperTests, (tests) =>
					tests.receive(
						callback.toString(),
						ownerKey({ tenantId: "another", userId: "another" }),
					),
				).pipe(Effect.flip),
			)
			assert.equal(wrongOwner._tag, "DeveloperNotFound")
			const badIssuer = new URL(callback)
			badIssuer.searchParams.set("iss", "https://wrong-issuer.example")
			assert.equal(
				(
					await fetch(address + badIssuer.pathname + badIssuer.search, {
						headers,
						redirect: "manual",
					})
				).status,
				409,
			)
			const flowId = started.authorization?.flowId ?? ""
			{
				await using restored = freshStores()
				const flow = await restored.runPromise(
					Effect.flatMap(DeveloperTestStores, (stores) =>
						stores.bind(owner, protectedTest.id).flows.get({
							key: { owner, connectionId: protectedTest.id },
							flowId,
						}),
					),
				)
				assert.ok(Redacted.value(flow.verifier).length >= 43)
				assert.equal(
					flow.binding.resource,
					"https://app.development.test/protected",
				)
			}

			const receipt = await fetch(
				address + callback.pathname + callback.search,
				{ headers, redirect: "manual" },
			)
			assert.equal(receipt.status, 303, await receipt.clone().text())
			assert.equal(
				receipt.headers.get("location"),
				"/?" + new URLSearchParams({ developerTest: protectedTest.id }),
			)
			assert.equal(
				(
					await fetch(address + callback.pathname + callback.search, {
						headers,
						redirect: "manual",
					})
				).status,
				409,
			)

			assert.equal(
				(
					await call((api) =>
						api.developer.test({ params: { id: protectedTest.id } }),
					)
				).authorization?.status,
				"Received",
			)
			assert.equal(
				(
					await call((api) =>
						api.developer.completeTestAuthorization({
							params: { id: protectedTest.id },
						}),
					)
				).authorization?.status,
				"Succeeded",
			)
			{
				await using restored = freshStores()
				await restored.runPromise(
					Effect.gen(function* () {
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
						assert.deepEqual(credential.scopes, ["documents"])
					}),
				)
			}

			const replay = await client.runPromise(
				Effect.flatMap(Client, (client) =>
					client.api.developer.completeTestAuthorization({
						params: { id: protectedTest.id },
					}),
				).pipe(Effect.result),
			)
			assert.equal(replay._tag, "Failure")

			await call((api) =>
				api.developer.runTest({ params: { id: protectedTest.id } }),
			)
			assert.equal((await settle(protectedTest.id)).status, "Succeeded")
			const account = await call((api) => api.account.session({}))
			assert.equal(
				await server.runPromise(
					Effect.flatMap(Business, (business) =>
						business.executions(ownerKey(account.identity)),
					),
				),
				0,
			)
			await mode("cleanup-failure")
			assert.equal(
				(
					await call((api) =>
						api.developer.cleanupTest({ params: { id: protectedTest.id } }),
					)
				).cleanup,
				"Pending",
			)
			await mode("available")
			assert.equal(
				(
					await call((api) =>
						api.developer.cleanupTest({ params: { id: protectedTest.id } }),
					)
				).cleanup,
				"Complete",
			)
			await server.runPromise(
				Effect.flatMap(IndexRepository, (index) => index.withdraw(cardUrl)),
			)
			const request = await call((api) =>
				api.developer.requestIndexing({ payload: { cardUrl } }),
			)
			assert.equal(request.check, null)
			assert.equal(
				(
					await call((api) =>
						api.developer.requestIndexing({ payload: { cardUrl } }),
					)
				).id,
				request.id,
			)
			await server.runPromise(
				Effect.flatMap(IndexWork, (work) => work.runOne(cardUrl)),
			)
			assert.equal(
				(
					await call((api) =>
						api.developer.indexingRequest({ params: { id: request.id } }),
					)
				).check?._tag,
				"Indexed",
			)
			assert.ok(
				Option.isSome(
					await server.runPromise(
						Effect.flatMap(IndexRepository, (index) => index.get(cardUrl)),
					),
				),
			)
			const jobsBefore = await sql(
				"SELECT generation, completed_generation, sources, requested_at FROM openbot_app_index_jobs WHERE namespace = 'development'",
			)
			await sql(
				"CREATE FUNCTION reject_developer_request() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.kind LIKE ''%:indexRequest'' THEN RAISE EXCEPTION ''fixture write failure''; END IF; RETURN NEW; END'",
			)
			await sql(
				"CREATE TRIGGER reject_developer_request BEFORE INSERT ON openbot_developer_records FOR EACH ROW EXECUTE FUNCTION reject_developer_request()",
			)
			try {
				const rejected = await client.runPromise(
					Effect.flatMap(Client, (client) =>
						client.api.developer.requestIndexing({ payload: { cardUrl } }),
					).pipe(Effect.result),
				)
				assert.equal(rejected._tag, "Failure")
				assert.deepEqual(
					await sql(
						"SELECT generation, completed_generation, sources, requested_at FROM openbot_app_index_jobs WHERE namespace = 'development'",
					),
					jobsBefore,
				)
			} finally {
				await sql(
					"DROP TRIGGER reject_developer_request ON openbot_developer_records",
				)
				await sql("DROP FUNCTION reject_developer_request()")
			}

			const next = await call((api) =>
				api.developer.requestIndexing({ payload: { cardUrl } }),
			)
			assert.notEqual(next.generation, request.generation)
			assert.equal(next.check, null)
			await publication("noindex")
			await server.runPromise(
				Effect.flatMap(IndexWork, (work) => work.runOne(cardUrl)),
			)
			assert.equal(
				(
					await call((api) =>
						api.developer.indexingRequest({ params: { id: next.id } }),
					)
				).check?._tag,
				"Withdrawn",
			)
			const monitor = async () =>
				server.runPromise(
					Effect.gen(function* () {
						const records = yield* DeveloperRepository
						const app = yield* records.apps.get(cardUrl)
						yield* records.apps.put(cardUrl, "", cardUrl, {
							...app,
							nextCheckAt: 0,
						})
						yield* (yield* DeveloperMonitor).run
					}),
				)
			await monitor()
			const notices = await call((api) =>
				api.developer.notifications({ query: {} }),
			)
			assert.equal(
				notices.filter((notice) => notice.kind === "IssueAppeared").length,
				1,
			)
			await monitor()
			assert.equal(
				(await call((api) => api.developer.notifications({ query: {} })))
					.length,
				notices.length,
			)
			await publication("published")
			await monitor()
			const recovered = await call((api) =>
				api.developer.notifications({ query: {} }),
			)
			assert.equal(
				recovered.filter((notice) => notice.kind === "IssueResolved").length,
				1,
			)
			const notice = recovered[0]
			assert.ok(notice !== undefined)
			await call((api) =>
				api.developer.readNotification({ params: { id: notice.id } }),
			)
			await call((api) =>
				api.developer.subscribe({ payload: { cardUrl, enabled: false } }),
			)
			await publication("noindex")
			await monitor()
			assert.equal(
				(await call((api) => api.developer.notifications({ query: {} })))
					.length,
				recovered.length,
			)
			await call((api) => api.appExperience.reset({}))
			assert.equal(
				(await call((api) => api.developer.overview({}))).proofs.length,
				2,
			)
			assert.equal(
				(await call((api) => api.developer.test({ params: { id: plain.id } })))
					.status,
				"Succeeded",
			)
			await call((api) =>
				api.developer.cleanupTest({ params: { id: plain.id } }),
			)
			await call((api) =>
				api.developer.deleteTest({ params: { id: plain.id } }),
			)
			await publication("published")
			const pendingAtRestart = await call((api) =>
				api.developer.requestIndexing({ payload: { cardUrl } }),
			)
			await server.runPromise(
				Effect.flatMap(DeveloperRepository, (records) =>
					records.apps.get(cardUrl).pipe(
						Effect.flatMap((app) =>
							records.apps.put(cardUrl, "", cardUrl, {
								...app,
								nextCheckAt: 0,
							}),
						),
					),
				),
			)

			await server.dispose()
			const restriction = {
				cardUrl,
				reason: "Fixture deployment restriction.",
				appealUrl: "https://publisher.example/appeal",
			}
			server = ManagedRuntime.make(
				Development.layer({ ...options, appRestrictions: [restriction] }),
			)
			await server.runPromise(
				Effect.flatMap(IndexWork, (work) => work.runOne(cardUrl)),
			)
			// The startup worker may take the job before this test calls runOne.
			const restrictedRequest = await server.runPromise(
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
			assert.equal(restrictedRequest.check?._tag, "Excluded")
			assert.deepEqual(restrictedRequest.restriction, restriction)
			const restricted = await server.runPromise(
				Effect.flatMap(DeveloperIndexing, (indexing) =>
					indexing.request(owner, cardUrl),
				).pipe(Effect.flip),
			)
			assert.ok(restricted._tag === "DeveloperRestricted")
			assert.equal(restricted.restriction.appealUrl, restriction.appealUrl)
			let restartedApp = await server.runPromise(
				Effect.flatMap(DeveloperRepository, (records) =>
					records.apps.get(cardUrl),
				),
			)
			for (
				let attempt = 0;
				restartedApp.nextCheckAt === 0 && attempt < 100;
				attempt++
			) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				restartedApp = await server.runPromise(
					Effect.flatMap(DeveloperRepository, (records) =>
						records.apps.get(cardUrl),
					),
				)
			}
			assert.ok(restartedApp.nextCheckAt > 0)

			assert.equal(
				(
					await server.runPromise(
						Effect.flatMap(DeveloperRepository, (records) =>
							records.tests.get(protectedTest.id),
						),
					)
				).value.status,
				"Cancelled",
			)
			assert.equal(
				(
					await server.runPromise(
						Effect.flatMap(DeveloperRepository, (records) =>
							records.proofs.list(),
						),
					)
				).length,
				2,
			)
			const persistedNotices = await server.runPromise(
				Effect.flatMap(DeveloperRepository, (records) =>
					records.notices.list(),
				),
			)
			assert.ok(
				persistedNotices.some(
					(record) =>
						record.value.id === notice.id && record.value.readAt !== null,
				),
			)
			const persistedSubscriptions = await server.runPromise(
				Effect.flatMap(DeveloperRepository, (records) =>
					records.subscriptions.list(),
				),
			)
			assert.ok(
				persistedSubscriptions.some(
					(record) =>
						record.value.cardUrl === cardUrl && record.value.enabled === false,
				),
			)
		} finally {
			await server.dispose()
			await database.close()
		}
	},
)
