import { randomBytes, randomUUID } from "node:crypto"
import { isIP } from "node:net"
import { DeveloperApi as Api } from "@openbot-build/api"
import { Discovery, Document, Network, Robots } from "@openbot-build/protocol"
import { PgClient } from "@effect/sql-pg"
import { and, eq, gt, inArray, ne } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Clock, Context, Effect, Layer, Match, Option, Schema } from "effect"
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

export const scopeKey = (scope: Api.ManagementScope): string =>
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
] as const satisfies ReadonlyArray<Api.Proof["status"]>
const usable = (proof: Api.Proof, now: number) =>
	proof.validUntil > now &&
	usableStatus.some((status) => status === proof.status)
export const normalizeScope = (
	scope: Api.ManagementScope,
): Effect.Effect<Api.ManagementScope, Api.DeveloperInputInvalid> =>
	Match.value(scope).pipe(
		Match.tagsExhaustive({
			AppCard: (value) =>
				Schema.decodeEffect(Document.Link)(value.cardUrl).pipe(
					Effect.map((cardUrl) => ({ _tag: "AppCard" as const, cardUrl })),
					Effect.mapError(() =>
						Api.DeveloperInputInvalid.make({
							message: "Enter an exact HTTPS Card URL without credentials.",
						}),
					),
				),
			PublisherHostname: (value) =>
				Effect.gen(function* () {
					const hostname = value.hostname
						.trim()
						.toLowerCase()
						.replace(/\.$/, "")
					if (
						!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
							hostname,
						) ||
						isIP(hostname) !== 0
					)
						return yield* Api.DeveloperInputInvalid.make({
							message:
								"Enter one exact public hostname, without a path, port or wildcard.",
						})
					return { _tag: "PublisherHostname" as const, hostname }
				}),
		}),
	)
export class DeveloperAccess extends Context.Service<
	DeveloperAccess,
	{
		readonly grants: (
			owner: string,
		) => Effect.Effect<ReadonlyArray<Api.Grant>, Api.Failure>
		readonly authorize: (
			owner: string,
			cardUrl: string,
			write?: boolean,
		) => Effect.Effect<ReadonlyArray<Api.Grant>, Api.Failure>
		/** Tell if the owner can see (or, with `write`, change) the App, instead of failing. */
		readonly allows: (
			owner: string,
			cardUrl: string,
			write?: boolean,
		) => Effect.Effect<boolean, Api.Failure>
		readonly overview: (owner: string) => Effect.Effect<
			{
				readonly apps: ReadonlyArray<Api.ManagedApp>
				readonly proofs: ReadonlyArray<Api.Proof>
				readonly grants: ReadonlyArray<Api.Grant>
			},
			Api.Failure
		>
		readonly start: (
			owner: string,
			scope: Api.ManagementScope,
		) => Effect.Effect<Api.Challenge, Api.Failure>
		readonly claim: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.Challenge, Api.Failure>
		readonly revoke: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.Challenge, Api.Failure>
		readonly verify: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.Proof, Api.Failure>
		readonly recheck: (id: string) => Effect.Effect<Api.Proof, Api.Failure>
		readonly relinquish: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.Proof, Api.Failure>
		readonly ownProof: (
			owner: string,
			id: string,
		) => Effect.Effect<ProofRecord, Api.Failure>
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
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const inTransaction = Rows.transaction(yield* PgClient.PgClient)
	const namespace = yield* IndexNamespace
	const domains = yield* DomainControl
	const network = yield* Network.PublicNetwork
	const robots = yield* Robots.Robots
	const inspections = yield* AppInspections
	const notFound = () => Api.DeveloperNotFound.make({})
	const conflict = (reason: string) => Api.DeveloperConflict.make({ reason })
	const proofWhere = (id: string) =>
		and(eq(developerProofs.namespace, namespace), eq(developerProofs.id, id))
	const claimWhere = (id: string) =>
		and(eq(developerClaims.namespace, namespace), eq(developerClaims.id, id))
	/** Read the proof. With `lock`, keep the row locked until the transaction ends. */
	const readProof = Effect.fn("DeveloperAccess.readProof")(function* (
		id: string,
		lock = false,
	) {
		const query = db.select().from(developerProofs).where(proofWhere(id))
		const row = (yield* Rows.stored(lock ? query.for("update") : query))[0]
		if (row === undefined) return yield* notFound()
		return yield* Rows.decodeProof(row)
	})
	const writeProof = Effect.fn("DeveloperAccess.writeProof")(function* (
		value: Api.Proof,
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
		lock = false,
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
				return yield* Api.DeveloperForbidden.make({})
			return yield* notFound()
		}
		return proof
	})
	const claim = Effect.fn("DeveloperAccess.claim")(function* (
		owner: string,
		id: string,
		lock = false,
	) {
		const query = db.select().from(developerClaims).where(claimWhere(id))
		const row = (yield* Rows.stored(lock ? query.for("update") : query))[0]
		if (row === undefined || row.owner !== owner) return yield* notFound()
		return yield* Rows.decodeClaim(row)
	})
	const setClaimStatus = (id: string, status: Api.Challenge["status"]) =>
		Rows.stored(
			db.update(developerClaims).set({ status }).where(claimWhere(id)),
		)
	const evidence = (scope: Api.ManagementScope, token: string) =>
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
				Effect.map(({ value }): Api.Grant => ({
					proofId: value.id,
					scope: value.scope,
					role: "administrator",
				})),
			),
		)
		const membered = yield* Effect.forEach(shared, (row) =>
			Effect.gen(function* () {
				const { value } = yield* Rows.decodeProof(row.proof)
				const role = yield* Schema.decodeUnknownEffect(Api.MemberRole)(
					row.role,
				).pipe(Effect.mapError(Rows.unavailable))
				return {
					proofId: value.id,
					memberId: row.memberId,
					scope: value.scope,
					role,
				} satisfies Api.Grant
			}),
		)
		return [...administered, ...membered]
	})
	const covers = (scope: Api.ManagementScope, candidate: Discovery.Candidate) =>
		Match.value(scope).pipe(
			Match.tagsExhaustive({
				AppCard: (value) => value.cardUrl === candidate.cardUrl,
				PublisherHostname: (value) =>
					new URL(candidate.cardUrl).hostname === value.hostname &&
					candidate.sources.some(
						(source) =>
							source.role === "catalog" &&
							URL.canParse(source.url) &&
							new URL(source.url).hostname === value.hostname,
					),
			}),
		)
	const authorize = Effect.fn("DeveloperAccess.authorize")(function* (
		owner: string,
		cardUrl: string,
		write: boolean = false,
	) {
		const app = yield* Rows.getApp(db, namespace, cardUrl)
		const all = (yield* grants(owner)).filter((grant) =>
			covers(grant.scope, app.candidate),
		)
		if (all.length === 0) return yield* notFound()
		if (write && all.every((grant) => grant.role === "viewer"))
			return yield* Api.DeveloperForbidden.make({})
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
	/** Add the sources of the App to its record, or create the record. */
	const rememberApp = (
		scope: Api.ManagementScope,
		observed: Discovery.Candidate,
	): Effect.Effect<void, Api.DeveloperUnavailable> =>
		inTransaction(
			Effect.gen(function* () {
				const previous = yield* Rows.findApp(
					db,
					namespace,
					observed.cardUrl,
					true,
				)
				const sources = [
					...observed.sources,
					...Option.match(previous, {
						onNone: () => [],
						onSome: (value) => value.candidate.sources,
					}),
				].filter(
					(source, index, values) =>
						values.findIndex(
							(value) => value.role === source.role && value.url === source.url,
						) === index,
				)
				const candidate = yield* Discovery.Candidate.decode({
					...observed,
					sources,
				}).pipe(Effect.mapError(Rows.unavailable))
				if (!covers(scope, candidate)) return true
				if (Option.isSome(previous)) {
					yield* Rows.putApp(db, namespace, { ...previous.value, candidate })
					return true
				}
				const now = yield* Clock.currentTimeMillis
				const encoded = yield* Schema.encodeEffect(
					Rows.Json(Discovery.Candidate),
				)(candidate).pipe(Effect.mapError(Rows.unavailable))
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
				return inserted.length === 1
			}),
		).pipe(
			Effect.flatMap((saved) =>
				saved ? Effect.void : rememberApp(scope, observed),
			),
		)
	const rememberApps = (scope: Api.ManagementScope) =>
		Effect.gen(function* () {
			const input = Match.value(scope).pipe(
				Match.tagsExhaustive({
					PublisherHostname: (value) => value.hostname,
					AppCard: (value) => value.cardUrl,
				}),
			)
			const report = yield* inspections.inspect(input)
			for (const app of report.apps) {
				const evidence = Match.value(app.eligibility).pipe(
					Match.tagsExhaustive({
						Eligible: (result) =>
							result.entry.evidence.map((item) => ({
								role: "catalog" as const,
								url: item.catalogUrl,
							})),
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
	const recheck = Effect.fn("DeveloperAccess.recheck")(function* (id: string) {
		const previous = yield* readProof(id)
		if (previous.value.status === "Relinquished")
			return yield* conflict("ProofRelinquished")
		const checked = yield* evidence(previous.value.scope, previous.token)
		const value = yield* inTransaction(
			Effect.gen(function* () {
				const current = yield* readProof(id, true)
				if (current.value.status === "Relinquished")
					return yield* conflict("ProofRelinquished")
				const now = yield* Clock.currentTimeMillis
				const assessed: Api.Proof = Match.value(checked).pipe(
					Match.tagsExhaustive({
						Success: ({ success }): Api.Proof => ({
							...current.value,
							status: success ? "Confirmed" : "Suspended",
							confirmedAt: success ? now : current.value.confirmedAt,
							validUntil: success ? now + 7 * 86400000 : now,
							nextVerificationAt: now + 86400000,
							reason: success ? null : "ProofRemoved",
						}),
						Failure: (): Api.Proof => ({
							...current.value,
							status:
								current.value.validUntil > now ? "Unconfirmed" : "Suspended",
							nextVerificationAt: now + 60000,
							reason: "VerificationUnavailable",
						}),
					}),
				)
				const value: Api.Proof = {
					...assessed,
					transition:
						current.value.transition +
						(assessed.status === current.value.status ? 0 : 1),
				}
				yield* writeProof(value)
				return value
			}),
		)
		yield* Match.value(value.status).pipe(
			Match.when("Confirmed", () => rememberApps(value.scope)),
			Match.orElse(() => Effect.void),
		)
		return value
	})
	return DeveloperAccess.of({
		grants,
		authorize,
		allows,
		ownProof: (owner, id) => ownProof(owner, id),
		claim: (owner, id) => claim(owner, id),
		recheck,
		overview: Effect.fn("DeveloperAccess.overview")(function* (owner) {
			const access = yield* grants(owner)
			const rows = yield* Rows.stored(
				db
					.select()
					.from(developerApps)
					.where(eq(developerApps.namespace, namespace)),
			)
			const apps = (yield* Effect.forEach(rows, Rows.decodeApp)).flatMap(
				(app) => {
					const applicable = access.filter((grant) =>
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
			const challenge: Api.Challenge = {
				id: yield* Effect.sync(randomUUID),
				scope,
				token:
					"openbot-verification=" +
					(yield* Effect.sync(() => randomBytes(32).toString("base64url"))),
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
					return { ...value, status: "Revoked" } satisfies Api.Challenge
				}),
			),
		verify: Effect.fn("DeveloperAccess.verify")(function* (owner, id) {
			const value = yield* claim(owner, id)
			const checked = yield* evidence(value.scope, value.token)
			const proof = yield* inTransaction(
				Effect.gen(function* () {
					const current = yield* claim(owner, id, true)
					if (current.status === "Confirmed")
						return (yield* ownProof(owner, id)).value
					if (current.status !== "Pending")
						return yield* conflict("ClaimInactive")
					const now = yield* Clock.currentTimeMillis
					if (current.expiresAt <= now) return yield* conflict("ClaimExpired")
					yield* Match.value(checked).pipe(
						Match.tagsExhaustive({
							Failure: () => Effect.fail(conflict("VerificationUnavailable")),
							Success: ({ success }) =>
								success ? Effect.void : Effect.fail(conflict("ProofMismatch")),
						}),
					)
					const proof: Api.Proof = {
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
					return proof
				}),
			)
			yield* rememberApps(proof.scope)
			return proof
		}),
		relinquish: (owner, id) =>
			inTransaction(
				Effect.gen(function* () {
					const current = yield* ownProof(owner, id, true)
					if (current.value.status === "Relinquished") return current.value
					const value: Api.Proof = {
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
							id: yield* Effect.sync(randomUUID),
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
