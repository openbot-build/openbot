import * as Models from "./DeveloperModels.ts"
import { Records } from "../errors/Records.ts"
import { DeveloperWatches } from "./DeveloperWatches.ts"
import * as DeveloperNotices from "./DeveloperNotices.ts"
import { isIP } from "node:net"
import { Developers } from "@openbot-build/domain"

import { Discovery, Document, Network, Robots } from "@openbot-build/protocol"
import { PgClient } from "@effect/sql-pg"
import { and, eq, gt, inArray, ne } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	HashSet,
	Match,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { Base64Url } from "effect/encoding"
import {
	developerApps,
	developerClaims,
	developerMembers,
	developerProofs,
} from "../database/Schema.ts"
import { AppInspections } from "./AppInspections.ts"
import * as Rows from "./DeveloperRows.ts"
import type { ProofRecord } from "./DeveloperRows.ts"
import { DomainControl } from "./DomainControl.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../errors/Failures.ts"

export const scopeKey = (scope: Developers.ManagementScope): string =>
	Match.value(scope).pipe(
		Match.tagsExhaustive({
			PublisherHostname: (value) => "hostname:" + value.hostname,
			AppCard: (value) => "card:" + value.cardUrl,
		}),
	)
/** A proof in these states still gives access. */
const usableStatus = [
	"Confirmed",
	"Unconfirmed",
] as const satisfies ReadonlyArray<Developers.Proof["status"]>
const usable = (proof: Developers.Proof, now: number) =>
	proof.validUntil > now &&
	Arr.some(usableStatus, (status) => status === proof.status)
export const normalizeScope = (
	scope: Developers.ManagementScope,
): Effect.Effect<
	Developers.ManagementScope,
	Developers.DeveloperInputInvalid
> =>
	Match.value(scope).pipe(
		Match.tagsExhaustive({
			AppCard: (value) =>
				Schema.decodeEffect(Document.Link)(value.cardUrl).pipe(
					Effect.map((cardUrl) => ({ _tag: "AppCard" as const, cardUrl })),
					Effect.catchTag("SchemaError", () =>
						Effect.fail(
							Developers.DeveloperInputInvalid.make({
								message: "Enter an exact HTTPS Card URL without credentials.",
							}),
						),
					),
				),
			PublisherHostname: (value) =>
				Effect.gen(function* () {
					const hostname = pipe(
						value.hostname,
						Str.trim,
						Str.toLowerCase,
						Str.replace(/\.$/, ""),
					)
					if (
						!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
							hostname,
						) ||
						isIP(hostname) !== 0
					)
						return yield* Developers.DeveloperInputInvalid.make({
							message:
								"Enter one exact public hostname, without a path, port or wildcard.",
						})
					return { _tag: "PublisherHostname" as const, hostname }
				}),
		}),
	)
const covers = (
	scope: Developers.ManagementScope,
	candidate: Discovery.Candidate,
) =>
	Match.value(scope).pipe(
		Match.tagsExhaustive({
			AppCard: (value) => value.cardUrl === candidate.cardUrl,
			PublisherHostname: (value) =>
				new URL(candidate.cardUrl).hostname === value.hostname &&
				Arr.some(
					candidate.sources,
					(source) =>
						source.role === "catalog" &&
						URL.canParse(source.url) &&
						new URL(source.url).hostname === value.hostname,
				),
		}),
	)

/** Current App grants use only saved records. No outside check runs here. */
export const authorization = Effect.gen(function* () {
	const db = yield* Db.make
	const namespace = yield* IndexNamespace
	/** The grants of the owner: the usable proofs they hold, and the usable proofs they are a member of. */
	const grants = Effect.fn("DeveloperAccess.grants")(function* (owner: string) {
		const now = yield* Clock.currentTimeMillis
		const usableProof = and(
			eq(developerProofs.namespace, namespace),
			inArray(developerProofs.status, [...usableStatus]),
			gt(developerProofs.validUntil, now),
		)
		const held = yield* Rows.stored(
			db
				.select()
				.from(developerProofs)
				.where(and(usableProof, eq(developerProofs.owner, owner))),
		)
		const shared = yield* Rows.stored(
			db
				.select({
					proof: developerProofs,
					memberId: developerMembers.id,
					role: developerMembers.role,
				})
				.from(developerMembers)
				.innerJoin(
					developerProofs,
					and(
						eq(developerProofs.namespace, developerMembers.namespace),
						eq(developerProofs.id, developerMembers.proofId),
					),
				)
				.where(
					and(
						usableProof,
						eq(developerMembers.owner, owner),
						ne(developerProofs.owner, owner),
					),
				),
		)
		const administered = yield* Effect.forEach(held, (row) =>
			Rows.decodeProof(row).pipe(
				Effect.map(({ value }): Developers.Grant => ({
					proofId: value.id,
					scope: value.scope,
					role: "administrator",
				})),
			),
		)
		const membered = yield* Effect.forEach(shared, (row) =>
			Effect.gen(function* () {
				const { value } = yield* Rows.decodeProof(row.proof)
				const role = yield* Rows.decodeRow(Developers.MemberRole)(row.role)
				return {
					proofId: value.id,
					memberId: row.memberId,
					scope: value.scope,
					role,
				} satisfies Developers.Grant
			}),
		)
		return [...administered, ...membered]
	})
	const authorize = Effect.fn("DeveloperAccess.authorize")(function* (
		owner: string,
		cardUrl: string,
		write: boolean = false,
	) {
		const app = yield* Rows.getApp(db, namespace, cardUrl)
		const all = Arr.filter(yield* grants(owner), (grant) =>
			covers(grant.scope, app.candidate),
		)
		if (all.length === 0) return yield* Developers.DeveloperNotFound.make({})
		if (write && Arr.every(all, (grant) => grant.role === "viewer"))
			return yield* Developers.DeveloperForbidden.make({})
		return all
	})
	const allows = (owner: string, cardUrl: string, write: boolean = false) =>
		authorize(owner, cardUrl, write).pipe(
			Effect.as(true),
			Effect.catchTags({
				DeveloperNotFound: () => Effect.succeed(false),
				DeveloperForbidden: () => Effect.succeed(false),
			}),
		)
	return { grants, authorize, allows }
})

export class DeveloperAccess extends Context.Service<
	DeveloperAccess,
	{
		readonly readProof: (
			id: string,
			lock?: boolean,
		) => Effect.Effect<
			ProofRecord,
			| Developers.StorageFailure
			| Developers.DeveloperNotFound
			| Developers.DeveloperForbidden
		>
		readonly checkEvidence: (
			scope: Developers.ManagementScope,
			token: string,
		) => Effect.Effect<Developers.ProofEvidence, Developers.StorageFailure>
		readonly inspectScope: (
			scope: Developers.ManagementScope,
		) => Effect.Effect<Models.InspectionReport, Developers.Failure>
		readonly applyEvidence: (
			previous: Developers.Proof,
			evidence: Developers.ProofEvidence,
			report: Models.InspectionReport | null,
		) => Effect.Effect<Developers.Proof, Developers.Failure>
		readonly grants: (
			owner: string,
		) => Effect.Effect<ReadonlyArray<Developers.Grant>, Developers.Failure>
		readonly authorize: (
			owner: string,
			cardUrl: string,
			write?: boolean,
		) => Effect.Effect<ReadonlyArray<Developers.Grant>, Developers.Failure>
		/** Tell if the owner can see (or, with `write`, change) the App, instead of failing. */
		readonly allows: (
			owner: string,
			cardUrl: string,
			write?: boolean,
		) => Effect.Effect<boolean, Developers.Failure>
		readonly overview: (owner: string) => Effect.Effect<
			{
				readonly apps: ReadonlyArray<Models.ManagedApp>
				readonly proofs: ReadonlyArray<Developers.Proof>
				readonly grants: ReadonlyArray<Developers.Grant>
			},
			Developers.Failure
		>
		readonly start: (
			owner: string,
			scope: Developers.ManagementScope,
		) => Effect.Effect<Developers.Challenge, Developers.Failure>
		readonly claim: (
			owner: string,
			id: string,
			lock?: boolean,
		) => Effect.Effect<
			Developers.Challenge,
			Developers.StorageFailure | Developers.DeveloperNotFound
		>
		readonly revoke: (
			owner: string,
			id: string,
		) => Effect.Effect<Developers.Challenge, Developers.Failure>
		readonly confirm: (
			owner: string,
			id: string,
			evidence: Developers.ProofEvidence,
			report: Models.InspectionReport | null,
		) => Effect.Effect<Developers.Proof, Developers.Failure>
		readonly relinquish: (
			owner: string,
			id: string,
		) => Effect.Effect<Developers.Proof, Developers.Failure>
		readonly ownProof: (
			owner: string,
			id: string,
			lock?: boolean,
		) => Effect.Effect<
			ProofRecord,
			| Developers.StorageFailure
			| Developers.DeveloperNotFound
			| Developers.DeveloperForbidden
		>
	}
>()("@openbot-build/openbot/apps/DeveloperAccess") {}

const Marker = Schema.fromJsonString(
	Schema.Struct({
		_meta: Schema.optionalKey(
			Schema.Struct({
				"openbot/developer-verification": Schema.optionalKey(
					Schema.Struct({
						version: Schema.Literal(1),
						tokens: Schema.Array(Schema.String),
					}),
				),
			}),
		),
	}),
)
export const make: Effect.Effect<
	typeof DeveloperAccess.Service,
	never,
	| PgClient.PgClient
	| DomainControl
	| Network.PublicNetwork
	| Robots.Robots
	| AppInspections
	| Crypto.Crypto
	| DeveloperWatches
	| Records
> = Effect.gen(function* () {
	const watches = yield* DeveloperWatches
	const errors = yield* Records
	const notices = yield* DeveloperNotices.make
	const db = yield* Db.make
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const domains = yield* DomainControl
	const network = yield* Network.PublicNetwork
	const robots = yield* Robots.Robots
	const inspections = yield* AppInspections
	const crypto = yield* Crypto.Crypto
	const { grants, authorize, allows } = yield* authorization
	const newId = crypto.randomUUIDv4().pipe(Effect.orDie)
	const conflict = (reason: string) =>
		Developers.DeveloperConflict.make({ reason })
	const proofWhere = (id: string) =>
		and(eq(developerProofs.namespace, namespace), eq(developerProofs.id, id))
	const claimWhere = (id: string) =>
		and(eq(developerClaims.namespace, namespace), eq(developerClaims.id, id))
	/** Read the proof. With `lock`, keep the row locked until the transaction ends. */
	const readProof = Effect.fn("DeveloperAccess.readProof")(function* (
		id: string,
		lock: boolean = false,
	) {
		const query = db.select().from(developerProofs).where(proofWhere(id))
		const row = (yield* Rows.stored(lock ? query.for("update") : query))[0]
		if (row === undefined) return yield* Developers.DeveloperNotFound.make({})
		return yield* Rows.decodeProof(row)
	})
	const writeProof = Effect.fn("DeveloperAccess.writeProof")(function* (
		value: Developers.Proof,
	) {
		const { id: _, ...row } = yield* Rows.encodeProof(value)
		yield* Rows.stored(
			db
				.update(developerProofs)
				.set({ ...row, scopeKey: scopeKey(value.scope) })
				.where(proofWhere(value.id)),
		)
	})
	const ownProof = Effect.fn("DeveloperAccess.ownProof")(function* (
		owner: string,
		id: string,
		lock: boolean = false,
	) {
		const proof = yield* readProof(id, lock)
		if (proof.owner !== owner) {
			const now = yield* Clock.currentTimeMillis
			const member = yield* Rows.stored(
				db
					.select({ id: developerMembers.id })
					.from(developerMembers)
					.where(
						and(
							eq(developerMembers.namespace, namespace),
							eq(developerMembers.proofId, id),
							eq(developerMembers.owner, owner),
						),
					)
					.limit(1),
			)
			if (usable(proof.value, now) && member.length > 0)
				return yield* Developers.DeveloperForbidden.make({})
			return yield* Developers.DeveloperNotFound.make({})
		}
		return proof
	})
	const claim = Effect.fn("DeveloperAccess.claim")(function* (
		owner: string,
		id: string,
		lock: boolean = false,
	) {
		const query = db.select().from(developerClaims).where(claimWhere(id))
		const row = (yield* Rows.stored(lock ? query.for("update") : query))[0]
		if (row === undefined || row.owner !== owner)
			return yield* Developers.DeveloperNotFound.make({})
		return yield* Rows.decodeClaim(row)
	})
	const setClaimStatus = (id: string, status: Developers.Challenge["status"]) =>
		Rows.stored(
			db.update(developerClaims).set({ status }).where(claimWhere(id)),
		)
	const evidence = (scope: Developers.ManagementScope, token: string) =>
		Match.value(scope).pipe(
			Match.tagsExhaustive({
				PublisherHostname: (value) =>
					domains
						.tokens(value.hostname)
						.pipe(Effect.map((tokens) => tokens.includes(token))),
				AppCard: (value) =>
					Effect.gen(function* () {
						const response = yield* network.readDocument({
							url: new URL("/robots.txt", value.cardUrl).href,
							followRedirects: false,
						})
						if (
							response.status >= 500 ||
							(response.status >= 300 && response.status < 400)
						)
							return yield* conflict("RobotsUnconfirmed")
						if (
							response.status >= 200 &&
							response.status < 300 &&
							!robots.allowed({
								text: response.text,
								productToken: Network.publicProductToken,
								url: value.cardUrl,
							})
						)
							return yield* conflict("RobotsDenied")
						const card = yield* network.readDocument({
							url: value.cardUrl,
							followRedirects: false,
						})
						if (
							card.url !== value.cardUrl ||
							(card.status >= 300 && card.status < 400)
						)
							return false
						if (card.status === 404 || card.status === 410) return false
						if (card.status !== 200) return yield* conflict("CardUnconfirmed")
						const marker = yield* Schema.decodeEffect(Marker)(card.text)
						return (
							marker._meta?.["openbot/developer-verification"]?.tokens.includes(
								token,
							) ?? false
						)
					}),
			}),
			Effect.result,
		)
	/** Add the sources of the App to its record, or create the record. */
	const rememberApp = (
		scope: Developers.ManagementScope,
		observed: Discovery.Candidate,
	): Effect.Effect<void, Developers.Failure> =>
		inTransaction(
			Effect.gen(function* () {
				const previous = yield* Rows.findApp(
					db,
					namespace,
					observed.cardUrl,
					true,
				)
				const combined = Arr.appendAll(
					observed.sources,
					Option.match(previous, {
						onNone: () => [],
						onSome: (value) => value.candidate.sources,
					}),
				)
				const sources = Arr.dedupeWith(
					combined,
					(a, b) => a.role === b.role && a.url === b.url,
				)
				const candidate = yield* Discovery.Candidate.decode({
					...observed,
					sources,
				}).pipe(
					Failures.replace("Could not join the sources of an App.", () =>
						Developers.DeveloperUnavailable.make({}),
					),
				)
				if (!covers(scope, candidate)) return true
				if (Option.isSome(previous)) {
					yield* Rows.putApp(db, namespace, { ...previous.value, candidate })
					yield* watches
						.ensure(
							{ kind: "App", id: candidate.cardUrl },
							previous.value.nextCheckAt,
						)
						.pipe(Rows.stored)
					return true
				}
				const now = yield* Clock.currentTimeMillis
				const encoded = yield* Rows.encodeRow(Rows.Json(Discovery.Candidate))(
					candidate,
				)
				// Another request may add the same App first. Then read it again and merge.
				const inserted = yield* Rows.stored(
					db
						.insert(developerApps)
						.values({
							namespace,
							cardUrl: candidate.cardUrl,
							candidate: encoded,
							nextCheckAt: now + 3600000,
						})
						.onConflictDoNothing()
						.returning({ cardUrl: developerApps.cardUrl }),
				)
				if (inserted.length === 1)
					yield* watches
						.ensure({ kind: "App", id: candidate.cardUrl }, now + 3600000)
						.pipe(Rows.stored)
				return inserted.length === 1
			}),
		).pipe(
			Effect.flatMap((saved) =>
				saved ? Effect.void : rememberApp(scope, observed),
			),
		)
	const inspectScope = (scope: Developers.ManagementScope) =>
		Effect.gen(function* () {
			const input = Match.value(scope).pipe(
				Match.tagsExhaustive({
					PublisherHostname: (value) => value.hostname,
					AppCard: (value) => value.cardUrl,
				}),
			)
			return yield* inspections.inspect(input)
		})
	const rememberReport = (
		scope: Developers.ManagementScope,
		report: Models.InspectionReport,
	) =>
		Effect.gen(function* () {
			for (const app of report.apps) {
				const evidence = Match.value(app.eligibility).pipe(
					Match.tagsExhaustive({
						Eligible: (result) =>
							Arr.map(result.entry.evidence, (item) =>
								Discovery.Source.make({
									role: "catalog",
									url: item.catalogUrl,
								}),
							),
						Excluded: () => [],
						Unconfirmed: () => [],
					}),
				)
				yield* rememberApp(scope, {
					...app.candidate,
					sources: [...app.candidate.sources, ...evidence],
				})
			}
		})
	const checkEvidence = (scope: Developers.ManagementScope, token: string) =>
		evidence(scope, token).pipe(
			Effect.flatMap(
				(
					result,
				): Effect.Effect<
					Developers.ProofEvidence,
					Developers.StorageFailure
				> =>
					result._tag === "Success"
						? Effect.succeed(
								result.success ? { _tag: "Matched" } : { _tag: "Missing" },
							)
						: errors.record(Cause.fail(result.failure), "external").pipe(
								Rows.stored,
								Effect.map((failure) => ({ _tag: "Unavailable", failure })),
							),
			),
		)
	const applyEvidence = Effect.fn("DeveloperAccess.applyEvidence")(function* (
		previous: Developers.Proof,
		evidence: Developers.ProofEvidence,
		report: Models.InspectionReport | null,
	) {
		const id = previous.id
		return yield* inTransaction(
			Effect.gen(function* () {
				const current = yield* readProof(id, true)
				if (!Schema.toEquivalence(Developers.Proof)(current.value, previous))
					return current.value
				if (current.value.status === "Relinquished") return current.value
				const now = yield* Clock.currentTimeMillis
				const value = Developers.assessProof(current.value, evidence, now)
				yield* writeProof(value)
				if (value.status !== current.value.status) {
					const members = yield* Rows.stored(
						db
							.select({ owner: developerMembers.owner })
							.from(developerMembers)
							.where(
								and(
									eq(developerMembers.namespace, namespace),
									eq(developerMembers.proofId, id),
								),
							),
					)
					for (const owner of HashSet.fromIterable([
						current.owner,
						...Arr.map(members, (row) => row.owner),
					])) {
						yield* notices.emit(
							owner,
							["proof", id, value.status, value.transition],
							{
								cardUrl: null,
								kind: "AccessChanged",
								issue: null,
								reason: value.reason ?? value.status,
								reportId: null,
								createdAt: now,
							},
						)
					}
				}
				if (value.status === "Confirmed" && report !== null)
					yield* rememberReport(value.scope, report)
				return value
			}),
		)
	})
	return DeveloperAccess.of({
		readProof,
		checkEvidence,
		inspectScope,
		applyEvidence,
		grants,
		authorize,
		allows,
		ownProof,
		claim,
		overview: Effect.fn("DeveloperAccess.overview")(function* (owner) {
			const access = yield* grants(owner)
			const rows = yield* Rows.stored(
				db
					.select()
					.from(developerApps)
					.where(eq(developerApps.namespace, namespace)),
			)
			const apps = Arr.flatMap(
				yield* Effect.forEach(rows, Rows.decodeApp),
				(app) => {
					const applicable = Arr.filter(access, (grant) =>
						covers(grant.scope, app.candidate),
					)
					return applicable.length === 0
						? []
						: [
								{
									cardUrl: app.candidate.cardUrl,
									candidate: app.candidate,
									grants: applicable,
								},
							]
				},
			)
			const proofs = yield* Rows.stored(
				db
					.select()
					.from(developerProofs)
					.where(
						and(
							eq(developerProofs.namespace, namespace),
							eq(developerProofs.owner, owner),
						),
					)
					.orderBy(developerProofs.id),
			)
			return {
				apps,
				proofs: yield* Effect.forEach(proofs, (row) =>
					Rows.decodeProof(row).pipe(Effect.map((proof) => proof.value)),
				),
				grants: access,
			}
		}),
		start: Effect.fn("DeveloperAccess.start")(function* (owner, value) {
			const scope = yield* normalizeScope(value)
			const now = yield* Clock.currentTimeMillis
			const challenge: Developers.Challenge = {
				id: yield* newId,
				scope,
				token:
					"openbot-verification=" +
					Base64Url.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie)),
				createdAt: now,
				expiresAt: now + 86400000,
				status: "Pending",
			}
			const row = yield* Rows.encodeClaim(challenge)
			yield* Rows.stored(
				db
					.insert(developerClaims)
					.values({ namespace, owner, scopeKey: scopeKey(scope), ...row }),
			)
			return challenge
		}),
		revoke: (owner, id) =>
			inTransaction(
				Effect.gen(function* () {
					const value = yield* claim(owner, id, true)
					if (value.status === "Confirmed")
						return yield* conflict("ClaimAlreadyConfirmed")
					yield* setClaimStatus(id, "Revoked")
					return { ...value, status: "Revoked" } satisfies Developers.Challenge
				}),
			),
		confirm: Effect.fn("DeveloperAccess.confirm")(
			function* (owner, id, checked, report) {
				return yield* inTransaction(
					Effect.gen(function* () {
						const current = yield* claim(owner, id, true)
						if (current.status === "Confirmed")
							return (yield* ownProof(owner, id)).value
						if (current.status !== "Pending")
							return yield* conflict("ClaimInactive")
						const now = yield* Clock.currentTimeMillis
						if (current.expiresAt <= now) return yield* conflict("ClaimExpired")
						if (checked._tag === "Unavailable")
							return yield* conflict("VerificationUnavailable")
						if (checked._tag === "Missing")
							return yield* conflict("ProofMismatch")
						const proof: Developers.Proof = {
							transition: 0,
							id,
							scope: current.scope,
							status: "Confirmed",
							confirmedAt: now,
							validUntil: now + 7 * 86400000,
							nextVerificationAt: now + 86400000,
							reason: null,
						}
						const row = yield* Rows.encodeProof(proof)
						yield* Rows.stored(
							db.insert(developerProofs).values({
								namespace,
								owner,
								token: current.token,
								scopeKey: scopeKey(proof.scope),
								...row,
							}),
						)
						yield* setClaimStatus(id, "Confirmed")
						yield* watches
							.ensure({ kind: "Proof", id }, proof.nextVerificationAt)
							.pipe(Rows.stored)
						if (report !== null) yield* rememberReport(proof.scope, report)
						return proof
					}),
				)
			},
		),
		relinquish: (owner, id) =>
			inTransaction(
				Effect.gen(function* () {
					const current = yield* ownProof(owner, id, true)
					if (current.value.status === "Relinquished") return current.value
					const value: Developers.Proof = {
						...current.value,
						transition: current.value.transition + 1,
						status: "Relinquished",
						validUntil: yield* Clock.currentTimeMillis,
						reason: "Relinquished",
					}
					yield* writeProof(value)
					const members = yield* Rows.stored(
						db
							.select({ owner: developerMembers.owner })
							.from(developerMembers)
							.where(
								and(
									eq(developerMembers.namespace, namespace),
									eq(developerMembers.proofId, id),
								),
							),
					)
					for (const member of members) {
						yield* Rows.postNotice(db, namespace, member.owner, {
							id: yield* newId,
							cardUrl: null,
							kind: "AccessChanged",
							issue: null,
							reason: "SourceProofRelinquished",
							reportId: null,
							createdAt: value.validUntil,
							readAt: null,
						})
					}
					return value
				}),
			),
	})
})
export const layer = Layer.effect(DeveloperAccess, make)
