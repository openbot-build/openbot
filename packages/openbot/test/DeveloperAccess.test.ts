import { SqlClient } from "effect/sql"
import * as Watches from "../src/apps/DeveloperWatches.ts"
import * as Records from "../src/errors/Records.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { DeveloperApi as Api } from "@openbot-build/api"
import {
	Discovery,
	Document,
	Network,
	RobotsPolicy,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Result,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Migration from "../src/database/Migrations.ts"
import * as Rows from "../src/apps/DeveloperRows.ts"
import * as AccessLayer from "../src/apps/DeveloperAccess.ts"
import { DeveloperAccess } from "../src/apps/DeveloperAccess.ts"
import * as MembersLayer from "../src/apps/DeveloperMembers.ts"
import { DeveloperMembers } from "../src/apps/DeveloperMembers.ts"
import * as ReportsLayer from "../src/apps/DeveloperReports.ts"
import { DeveloperReports } from "../src/apps/DeveloperReports.ts"
import { AppInspections } from "../src/apps/AppInspections.ts"
import {
	DomainControl,
	DomainControlUnavailable,
} from "../src/apps/DomainControl.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Db from "../src/database/Database.ts"

const alice = ownerKey({
	organizationId: "alice-organization",
	userId: "alice",
})
const bobIdentity = { organizationId: "bob-organization", userId: "bob" }
const bob = ownerKey(bobIdentity)
const cardUrl = "https://publisher.example/card?app=notes"
const candidate = Discovery.Candidate.make({
	cardUrl,
	card: {
		$schema: Document.cardSchemaUrl,
		name: "publisher.example/notes",
		version: "1.0.0",
		description: "Notes",
		remotes: [
			{
				type: "streamable-http",
				url: "https://publisher.example/mcp",
				supportedProtocolVersions: [Document.protocolVersion],
			},
		],
	},
	endpoints: [],
	sources: [
		{
			role: "catalog",
			url: "https://publisher.example/.well-known/ai-catalog.json",
		},
	],
})

// The test uses a real PostgreSQL server, so it runs in real time.
layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	it.effect(
		"developer proofs, members and report history stay saved without sharing account capabilities",
		() =>
			Effect.gen(function* () {
				const database = yield* Postgres.start
				const tokens = yield* Ref.make<ReadonlyArray<string>>([])
				const unavailable = yield* Ref.make(false)
				const robotsDenied = yield* Ref.make(false)
				const hasIssue = yield* Ref.make(true)
				const inspections = Layer.succeed(AppInspections, {
					inspect: (input) =>
						Effect.map(
							Ref.get(hasIssue),
							(withIssue): Api.InspectionReport => ({
								input,
								checkedAt: 100,
								stages: [],
								apps: [
									{
										candidate,
										eligibility: {
											_tag: "Excluded",
											cardUrl,
											reason: "NoIndex",
											withdraw: true,
											stages: [],
										},
										stored: { _tag: "Known", check: null },
									},
								],
								issues: withIssue
									? [
											{
												code: "NoIndex",
												stage: "indexing",
												severity: "blocking",
												source: cardUrl,
												message: "Noindex is declared.",
												repair: "Remove noindex to allow indexing.",
											},
										]
									: [],
							}),
						),
				})
				const dependencies = Layer.mergeAll(
					inspections,
					RobotsPolicy.layer,
					Layer.succeed(DomainControl, {
						tokens: () =>
							Effect.flatMap(Ref.get(unavailable), (down) =>
								down
									? Effect.fail(DomainControlUnavailable.make({}))
									: Ref.get(tokens),
							),
					}),
					Layer.succeed(Network.PublicNetwork, {
						readDocument: (options) =>
							Effect.flatMap(Ref.get(unavailable), (down) =>
								down
									? Effect.fail(
											Network.NetworkError.make({
												reason: "Transport",
												message: "Temporary outage",
											}),
										)
									: Effect.flatMap(Ref.get(robotsDenied), (denied) =>
											denied && Str.endsWith("robots.txt")(options.url)
												? Effect.succeed({
														url: options.url,
														status: 200,
														headers: {},
														text: "User-agent: *\nDisallow: /\n",
													})
												: Effect.map(Ref.get(tokens), (current) => ({
														url: options.url,
														status: Str.endsWith("robots.txt")(options.url)
															? 404
															: 200,
														headers: {},
														text: JSON.stringify({
															_meta: {
																"openbot/developer-verification": {
																	version: 1,
																	tokens: current,
																},
															},
														}),
													})),
										),
							),
					}),
				)
				// Each call makes new services, so the second program starts like a new server.
				const servicesFor = () =>
					Layer.mergeAll(MembersLayer.layer, ReportsLayer.layer).pipe(
						Layer.provideMerge(AccessLayer.layer),
						Layer.provideMerge(Watches.layer),
						Layer.provideMerge(Layer.merge(Store.layer, Records.layer)),
						Layer.provide(
							Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
						),
						Layer.provideMerge(dependencies),
						Layer.provideMerge(
							Database.layer({ databaseUrl: Redacted.make(database.url) }),
						),
						Layer.provideMerge(TestClock.layer()),
					)
				/** Runs a program on new services, like a server that starts again. */
				const onNewServices = <A, E>(
					program: Effect.Effect<
						A,
						E,
						Layer.Success<ReturnType<typeof servicesFor>>
					>,
				) => Effect.provide(program, servicesFor())
				const saved = yield* Effect.gen(function* () {
					yield* Migration.initialize
					const access = yield* DeveloperAccess
					const confirm = (owner: string, id: string) =>
						Effect.gen(function* () {
							const claim = yield* access.claim(owner, id)
							const checked = yield* access.checkEvidence(
								claim.scope,
								claim.token,
							)
							return yield* access.confirm(
								owner,
								id,
								checked,
								checked._tag === "Matched"
									? yield* access.inspectScope(claim.scope)
									: null,
							)
						})
					const assess = (id: string) =>
						Effect.gen(function* () {
							const previous = yield* access.readProof(id)
							const checked = yield* access.checkEvidence(
								previous.value.scope,
								previous.token,
							)
							return yield* access.applyEvidence(
								previous.value,
								checked,
								checked._tag === "Matched"
									? yield* access.inspectScope(previous.value.scope)
									: null,
							)
						})
					const members = yield* DeveloperMembers
					const reports = yield* DeveloperReports
					const db = yield* Db.make
					const seedApp = (app: {
						readonly candidate: Discovery.Candidate
						readonly nextCheckAt: number
					}) =>
						Rows.putApp(db, "public", {
							...app,
							cardUrl: app.candidate.cardUrl,
							leaseUntil: 0,
							monitorToken: null,
							monitorRevision: 0,
							monitorIssues: [],
						})
					const challenge = yield* access.start(alice, {
						_tag: "AppCard",
						cardUrl,
					})
					assert.strictEqual(
						(yield* Effect.flip(access.claim(bob, challenge.id)))._tag,
						"DeveloperNotFound",
					)
					assert.strictEqual(
						(yield* Effect.flip(confirm(alice, challenge.id)))._tag,
						"DeveloperConflict",
					)
					yield* Ref.set(tokens, [challenge.token])
					yield* Ref.set(robotsDenied, true)
					const denied = yield* Effect.flip(confirm(alice, challenge.id))
					assert.ok(denied._tag === "DeveloperConflict")
					assert.strictEqual(denied.reason, "VerificationUnavailable")
					yield* Ref.set(robotsDenied, false)
					const proof = yield* confirm(alice, challenge.id)
					assert.strictEqual(proof.status, "Confirmed")
					assert.strictEqual((yield* access.overview(alice)).apps.length, 1)
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(bob, cardUrl)))._tag,
						"DeveloperNotFound",
					)
					const copied = yield* access.start(alice, {
						_tag: "AppCard",
						cardUrl: "https://publisher.example/other?app=notes",
					})
					assert.strictEqual(
						(yield* Effect.flip(confirm(alice, copied.id)))._tag,
						"DeveloperConflict",
					)
					const revokedClaim = yield* access.start(alice, {
						_tag: "AppCard",
						cardUrl: "https://other.example/card",
					})
					yield* access.revoke(alice, revokedClaim.id)
					assert.strictEqual(
						(yield* Effect.flip(confirm(alice, revokedClaim.id)))._tag,
						"DeveloperConflict",
					)
					assert.notStrictEqual(
						(yield* access.start(alice, revokedClaim.scope)).id,
						revokedClaim.id,
					)
					const expiringClaim = yield* access.start(alice, {
						_tag: "PublisherHostname",
						hostname: "unpublished.example",
					})
					const revoked = yield* members.invite(alice, proof.id, "viewer")
					yield* members.revoke(alice, revoked.id)
					assert.strictEqual(
						(yield* Effect.flip(members.accept(bobIdentity, revoked.id)))._tag,
						"DeveloperConflict",
					)
					const invitation = yield* members.invite(alice, proof.id, "viewer")
					assert.strictEqual((yield* access.overview(bob)).apps.length, 0)
					const accepts = yield* Effect.all(
						[
							members.accept(bobIdentity, invitation.id).pipe(Effect.result),
							members
								.accept(
									{ organizationId: "third", userId: "third" },
									invitation.id,
								)
								.pipe(Effect.result),
						],
						{ concurrency: 2 },
					)
					assert.strictEqual(Arr.filter(accepts, Result.isSuccess).length, 1)
					if (
						!Arr.some(
							yield* access.grants(bob),
							(grant) => grant.proofId === proof.id,
						)
					) {
						const another = yield* members.invite(alice, proof.id, "viewer")
						yield* members.accept(bobIdentity, another.id)
					}
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(bob, cardUrl, true)))._tag,
						"DeveloperForbidden",
					)
					assert.strictEqual(
						(yield* Effect.flip(members.invite(bob, proof.id, "viewer")))._tag,
						"DeveloperForbidden",
					)
					const bobMember = Arr.findFirst(
						(yield* members.list(alice, proof.id)).members,
						(member) => member.identity.userId === bobIdentity.userId,
					)
					assert.ok(Option.isSome(bobMember))
					yield* members.change(alice, bobMember.value.id, "maintainer")
					yield* access.authorize(bob, cardUrl, true)
					yield* members.remove(alice, bobMember.value.id)
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(bob, cardUrl)))._tag,
						"DeveloperNotFound",
					)
					const restoredInvite = yield* members.invite(
						alice,
						proof.id,
						"viewer",
					)
					yield* members.accept(bobIdentity, restoredInvite.id)
					const before = yield* reports.save(alice, cardUrl)
					yield* Ref.set(hasIssue, false)
					const after = yield* reports.save(alice, cardUrl)
					assert.strictEqual(
						(yield* reports.compare(bob, before.id, after.id)).resolved[0]
							?.code,
						"NoIndex",
					)
					assert.strictEqual(
						(yield* Effect.flip(reports.remove(bob, before.id)))._tag,
						"DeveloperNotFound",
					)
					const independent = yield* access.start(bob, {
						_tag: "AppCard",
						cardUrl,
					})
					yield* Ref.update(tokens, Arr.append(independent.token))
					yield* confirm(bob, independent.id)
					assert.strictEqual(
						(yield* Effect.flip(access.relinquish(alice, independent.id)))._tag,
						"DeveloperNotFound",
					)
					const staleInvitation = yield* members.invite(
						alice,
						proof.id,
						"viewer",
					)
					yield* access.relinquish(alice, proof.id)
					const inactive = yield* Effect.flip(
						members.accept(
							{ organizationId: "fresh", userId: "fresh" },
							staleInvitation.id,
						),
					)
					assert.ok(inactive._tag === "DeveloperConflict")
					assert.strictEqual(inactive.reason, "InvitationSourceInactive")
					assert.strictEqual(
						(yield* access.authorize(bob, cardUrl, true)).length,
						1,
					)
					assert.strictEqual((yield* assess(proof.id)).status, "Relinquished")
					const domain = yield* access.start(alice, {
						_tag: "PublisherHostname",
						hostname: "publisher.example",
					})
					yield* Ref.update(tokens, Arr.append(domain.token))
					yield* confirm(alice, domain.id)
					const child = "https://sub.publisher.example/card"
					yield* seedApp({
						candidate: yield* Discovery.Candidate.decode({
							...candidate,
							cardUrl: child,
						}),
						nextCheckAt: 0,
					})
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(alice, child)))._tag,
						"DeveloperNotFound",
					)
					const distinct = Str.replace("notes", "other")(cardUrl)
					yield* seedApp({
						candidate: yield* Discovery.Candidate.decode({
							...candidate,
							cardUrl: distinct,
						}),
						nextCheckAt: 0,
					})
					assert.strictEqual(
						(yield* access.authorize(alice, distinct)).length,
						1,
					)
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(bob, distinct)))._tag,
						"DeveloperNotFound",
					)
					const unlisted = "https://publisher.example/unlisted?app=private"
					yield* seedApp({
						candidate: yield* Discovery.Candidate.decode({
							...candidate,
							cardUrl: unlisted,
							sources: [],
						}),
						nextCheckAt: 0,
					})
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(alice, unlisted)))._tag,
						"DeveloperNotFound",
					)
					const hosted = "https://hosting.example/customer/card"
					yield* seedApp({
						candidate: yield* Discovery.Candidate.decode({
							...candidate,
							cardUrl: hosted,
						}),
						nextCheckAt: 0,
					})
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(alice, hosted)))._tag,
						"DeveloperNotFound",
					)
					const expiringInvite = yield* members.invite(
						alice,
						domain.id,
						"viewer",
					)
					const sql = yield* SqlClient.SqlClient
					const beforeCheck = (yield* access.readProof(domain.id)).value
					// A lost notice write must also roll back the access change.
					yield* sql`create function reject_proof_notice() returns trigger language plpgsql as $$ begin raise exception 'Fixture notice write failure'; end $$`
					yield* sql`create trigger reject_proof_notice before insert on openbot_developer_notices for each row execute function reject_proof_notice()`
					assert.equal(
						(yield* access
							.applyEvidence(beforeCheck, { _tag: "Missing" }, null)
							.pipe(Effect.flip))._tag,
						"ExecutionStorageError",
					)
					assert.deepEqual(
						(yield* access.readProof(domain.id)).value,
						beforeCheck,
					)
					yield* sql`drop trigger reject_proof_notice on openbot_developer_notices`
					yield* sql`drop function reject_proof_notice()`
					yield* Ref.set(unavailable, true)
					const unconfirmed = yield* assess(domain.id)
					assert.strictEqual(unconfirmed.status, "Unconfirmed")
					// An older network result cannot replace the newer proof state.
					assert.deepEqual(
						yield* access.applyEvidence(beforeCheck, { _tag: "Missing" }, null),
						unconfirmed,
					)
					const until = unconfirmed.validUntil
					yield* TestClock.adjust("8 days")
					assert.strictEqual((yield* assess(domain.id)).validUntil, until)
					assert.strictEqual(
						(yield* Effect.flip(access.authorize(alice, cardUrl)))._tag,
						"DeveloperNotFound",
					)
					assert.strictEqual(
						(yield* Effect.flip(members.accept(bobIdentity, expiringInvite.id)))
							._tag,
						"DeveloperConflict",
					)
					const expiredClaim = yield* Effect.flip(
						confirm(alice, expiringClaim.id),
					)
					assert.ok(expiredClaim._tag === "DeveloperConflict")
					assert.strictEqual(expiredClaim.reason, "ClaimExpired")
					assert.ok(
						(yield* access.start(alice, expiringClaim.scope)).expiresAt >
							expiringClaim.expiresAt,
					)
					yield* Ref.set(unavailable, false)
					assert.strictEqual((yield* assess(domain.id)).status, "Confirmed")
					return { proofId: proof.id, reportId: before.id }
				}).pipe(onNewServices)
				yield* Effect.gen(function* () {
					const access = yield* DeveloperAccess
					assert.strictEqual(
						(yield* access.ownProof(alice, saved.proofId)).value.status,
						"Relinquished",
					)
					assert.strictEqual(
						(yield* (yield* DeveloperReports).get(alice, saved.reportId)).report
							.issues[0]?.code,
						"NoIndex",
					)
				}).pipe(onNewServices)
			}),
	)
})
