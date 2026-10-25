// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { DeveloperApi as Api } from "@openbot-build/api"
import {
	Discovery,
	Document,
	Network,
	RobotsPolicy,
} from "@openbot-build/protocol"
import { Effect, Layer, Redacted, Schema } from "effect"
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
const candidate = Schema.decodeSync(Discovery.Candidate)({
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

it.live(
	"developer proofs, members and report history stay saved without sharing account capabilities",
	() =>
		Effect.gen(function* () {
			const database = yield* Effect.acquireRelease(
				Effect.promise(() => Postgres.start()),
				(database) => Effect.promise(() => database.close()),
			)
			let tokens: ReadonlyArray<string> = []
			let unavailable = false
			let hasIssue = true
			const inspections = Layer.succeed(AppInspections, {
				inspect: (input) =>
					Effect.succeed<Api.InspectionReport>({
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
						issues: hasIssue
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
			})
			const dependencies = Layer.mergeAll(
				inspections,
				RobotsPolicy.layer,
				Layer.succeed(DomainControl, {
					tokens: () =>
						unavailable
							? Effect.fail(DomainControlUnavailable.make({}))
							: Effect.succeed(tokens),
				}),
				Layer.succeed(Network.PublicNetwork, {
					readDocument: (options) =>
						unavailable
							? Effect.fail(
									Network.NetworkError.make({
										reason: "Transport",
										message: "Temporary outage",
									}),
								)
							: Effect.succeed({
									url: options.url,
									status: options.url.endsWith("robots.txt") ? 404 : 200,
									headers: {},
									text: JSON.stringify({
										_meta: {
											"openbot/developer-verification": { version: 1, tokens },
										},
									}),
								}),
				}),
			)
			// Each call makes new services, so the second program starts like a new server.
			const servicesFor = () =>
				Layer.mergeAll(MembersLayer.layer, ReportsLayer.layer).pipe(
					Layer.provideMerge(AccessLayer.layer),
					Layer.provideMerge(dependencies),
					Layer.provideMerge(
						Database.layer({ databaseUrl: Redacted.make(database.url) }),
					),
					Layer.provideMerge(TestClock.layer()),
					Layer.provide(NodeServices.layer),
				)
			let proofId = ""
			let reportId = ""
			yield* Effect.gen(function* () {
				yield* Migration.initialize
				const access = yield* DeveloperAccess
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
					(yield* Effect.flip(access.verify(alice, challenge.id)))._tag,
					"DeveloperConflict",
				)
				tokens = [challenge.token]
				const proof = yield* access.verify(alice, challenge.id)
				proofId = proof.id
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
					(yield* Effect.flip(access.verify(alice, copied.id)))._tag,
					"DeveloperConflict",
				)
				const revokedClaim = yield* access.start(alice, {
					_tag: "AppCard",
					cardUrl: "https://other.example/card",
				})
				yield* access.revoke(alice, revokedClaim.id)
				assert.strictEqual(
					(yield* Effect.flip(access.verify(alice, revokedClaim.id)))._tag,
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
				assert.strictEqual(
					accepts.filter((result) => result._tag === "Success").length,
					1,
				)
				if (
					!(yield* access.grants(bob)).some(
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
				const bobMember = (yield* members.list(alice, proof.id)).members.find(
					(member) => member.identity.userId === bobIdentity.userId,
				)
				assert.ok(bobMember !== undefined)
				yield* members.change(alice, bobMember.id, "maintainer")
				yield* access.authorize(bob, cardUrl, true)
				yield* members.remove(alice, bobMember.id)
				assert.strictEqual(
					(yield* Effect.flip(access.authorize(bob, cardUrl)))._tag,
					"DeveloperNotFound",
				)
				const restoredInvite = yield* members.invite(alice, proof.id, "viewer")
				yield* members.accept(bobIdentity, restoredInvite.id)
				const before = yield* reports.save(alice, cardUrl)
				reportId = before.id
				hasIssue = false
				const after = yield* reports.save(alice, cardUrl)
				assert.strictEqual(
					(yield* reports.compare(bob, before.id, after.id)).resolved[0]?.code,
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
				tokens = [...tokens, independent.token]
				yield* access.verify(bob, independent.id)
				assert.strictEqual(
					(yield* Effect.flip(access.relinquish(alice, independent.id)))._tag,
					"DeveloperNotFound",
				)
				const staleInvitation = yield* members.invite(alice, proof.id, "viewer")
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
				assert.strictEqual(
					(yield* Effect.flip(access.recheck(proof.id)))._tag,
					"DeveloperConflict",
				)
				const domain = yield* access.start(alice, {
					_tag: "PublisherHostname",
					hostname: "publisher.example",
				})
				tokens = [...tokens, domain.token]
				yield* access.verify(alice, domain.id)
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
				const distinct = cardUrl.replace("notes", "other")
				yield* seedApp({
					candidate: yield* Discovery.Candidate.decode({
						...candidate,
						cardUrl: distinct,
					}),
					nextCheckAt: 0,
				})
				assert.strictEqual((yield* access.authorize(alice, distinct)).length, 1)
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
				const expiringInvite = yield* members.invite(alice, domain.id, "viewer")
				unavailable = true
				const unconfirmed = yield* access.recheck(domain.id)
				assert.strictEqual(unconfirmed.status, "Unconfirmed")
				const until = unconfirmed.validUntil
				yield* TestClock.adjust("8 days")
				assert.strictEqual((yield* access.recheck(domain.id)).validUntil, until)
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
					access.verify(alice, expiringClaim.id),
				)
				assert.ok(expiredClaim._tag === "DeveloperConflict")
				assert.strictEqual(expiredClaim.reason, "ClaimExpired")
				assert.ok(
					(yield* access.start(alice, expiringClaim.scope)).expiresAt >
						expiringClaim.expiresAt,
				)
				unavailable = false
				assert.strictEqual(
					(yield* access.recheck(domain.id)).status,
					"Confirmed",
				)
			}).pipe(Effect.provide(servicesFor()))
			yield* Effect.gen(function* () {
				const access = yield* DeveloperAccess
				assert.strictEqual(
					(yield* access.ownProof(alice, proofId)).value.status,
					"Relinquished",
				)
				assert.strictEqual(
					(yield* (yield* DeveloperReports).get(alice, reportId)).report
						.issues[0]?.code,
					"NoIndex",
				)
			}).pipe(Effect.provide(servicesFor()))
		}),
)
