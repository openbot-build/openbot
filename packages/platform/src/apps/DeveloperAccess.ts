import { randomBytes, randomUUID } from "node:crypto"
import { isIP } from "node:net"
import { DeveloperApi as Api } from "@openbot-build/platform-api"
import { Discovery, Document, Network, Robots } from "@openbot-build/protocol"
import { Clock, Context, Effect, Layer, Match, Schema } from "effect"
import { AppInspections } from "./AppInspections.ts"
import { DeveloperRepository, type ProofRecord } from "./DeveloperRepository.ts"
import { DomainControl } from "./DomainControl.ts"

export const scopeKey = (scope: Api.ManagementScope): string =>
	Match.value(scope).pipe(
		Match.tagsExhaustive({
			PublisherHostname: (value) => "hostname:" + value.hostname,
			AppCard: (value) => "card:" + value.cardUrl,
		}),
	)
const usable = (proof: Api.Proof, now: number) =>
	proof.validUntil > now && ["Confirmed", "Unconfirmed"].includes(proof.status)
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
>()("@openbot-build/platform/apps/DeveloperAccess") {}

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
	| DeveloperRepository
	| DomainControl
	| Network.PublicNetwork
	| Robots.Robots
	| AppInspections
> = Effect.gen(function* () {
	const records = yield* DeveloperRepository
	const domains = yield* DomainControl
	const network = yield* Network.PublicNetwork
	const robots = yield* Robots.Robots
	const inspections = yield* AppInspections
	const notFound = () => Api.DeveloperNotFound.make({})
	const conflict = (reason: string) => Api.DeveloperConflict.make({ reason })
	const ownProof = Effect.fn("DeveloperAccess.ownProof")(function* (
		owner: string,
		id: string,
	) {
		const proof = yield* records.proofs.get(id)
		if (proof.owner !== owner) {
			const now = yield* Clock.currentTimeMillis
			if (
				usable(proof.value, now) &&
				(yield* records.members.list({ owner })).some(
					(member) => member.value.proofId === id,
				)
			)
				return yield* Api.DeveloperForbidden.make({})
			return yield* notFound()
		}
		return proof
	})
	const claim = Effect.fn("DeveloperAccess.claim")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* records.claims.get(id)
		if (record.owner !== owner) return yield* notFound()
		return record.value
	})
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
	const grants = Effect.fn("DeveloperAccess.grants")(function* (owner: string) {
		const now = yield* Clock.currentTimeMillis
		const proofs = yield* records.proofs.list()
		const members = yield* records.members.list({ owner })
		return proofs
			.filter((record) => usable(record.value, now))
			.flatMap<Api.Grant>((record) => {
				if (record.owner === owner)
					return [
						{
							proofId: record.value.id,
							scope: record.value.scope,
							role: "administrator" as const,
						},
					]
				return members
					.filter((member) => member.value.proofId === record.value.id)
					.map((member) => ({
						proofId: record.value.id,
						memberId: member.value.id,
						scope: record.value.scope,
						role: member.value.role,
					}))
			})
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
		const app = yield* records.apps.get(cardUrl)
		const all = (yield* grants(owner)).filter((grant) =>
			covers(grant.scope, app.candidate),
		)
		if (all.length === 0) return yield* notFound()
		if (write && all.every((grant) => grant.role === "viewer"))
			return yield* Api.DeveloperForbidden.make({})
		return all
	})
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
				yield* records.transaction(
					"monitor:" + app.candidate.cardUrl,
					Effect.gen(function* () {
						const previous = yield* records.apps
							.get(app.candidate.cardUrl)
							.pipe(
								Effect.catchTag("DeveloperNotFound", () =>
									Effect.succeed(null),
								),
							)
						const sources = [
							...app.candidate.sources,
							...evidence,
							...(previous?.candidate.sources ?? []),
						].filter(
							(source, index, values) =>
								values.findIndex(
									(value) =>
										value.role === source.role && value.url === source.url,
								) === index,
						)
						const candidate = yield* Discovery.Candidate.decode({
							...app.candidate,
							sources,
						}).pipe(Effect.mapError(() => Api.DeveloperUnavailable.make({})))
						if (!covers(scope, candidate)) return
						yield* records.apps.put(candidate.cardUrl, "", scopeKey(scope), {
							...previous,
							candidate,
							nextCheckAt:
								previous?.nextCheckAt ??
								(yield* Clock.currentTimeMillis) + 3600000,
						})
					}),
				)
			}
		})
	const recheck = Effect.fn("DeveloperAccess.recheck")(function* (id: string) {
		const previous = yield* records.proofs.get(id)
		if (previous.value.status === "Relinquished")
			return yield* conflict("ProofRelinquished")
		const checked = yield* evidence(previous.value.scope, previous.token)
		const value = yield* records.transaction(
			scopeKey(previous.value.scope),
			Effect.gen(function* () {
				const current = yield* records.proofs.get(id)
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
				yield* records.proofs.put(id, current.owner, scopeKey(value.scope), {
					...current,
					value,
				})
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
		ownProof,
		claim,
		recheck,
		overview: (owner) =>
			Effect.gen(function* () {
				const access = yield* grants(owner)
				const apps = (yield* records.apps.list()).flatMap((app) => {
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
				})
				return {
					apps,
					proofs: (yield* records.proofs.list({ owner })).map(
						(record) => record.value,
					),
					grants: access,
				}
			}),
		start: (owner, value) =>
			Effect.gen(function* () {
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
				yield* records.claims.put(challenge.id, owner, scopeKey(scope), {
					owner,
					value: challenge,
				})
				return challenge
			}),
		revoke: (owner, id) =>
			records.transaction(
				"claim:" + id,
				Effect.gen(function* () {
					const value = yield* claim(owner, id)
					if (value.status === "Confirmed")
						return yield* conflict("ClaimAlreadyConfirmed")
					const revoked: Api.Challenge = { ...value, status: "Revoked" }
					yield* records.claims.put(id, owner, scopeKey(value.scope), {
						owner,
						value: revoked,
					})
					return revoked
				}),
			),
		verify: (owner, id) =>
			Effect.gen(function* () {
				const value = yield* claim(owner, id)
				const checked = yield* evidence(value.scope, value.token)
				const proof = yield* records.transaction(
					"claim:" + id,
					Effect.gen(function* () {
						const current = yield* claim(owner, id)
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
									success
										? Effect.void
										: Effect.fail(conflict("ProofMismatch")),
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
						yield* records.proofs.put(id, owner, scopeKey(proof.scope), {
							owner,
							value: proof,
							token: current.token,
						})
						yield* records.claims.put(id, owner, scopeKey(proof.scope), {
							owner,
							value: { ...current, status: "Confirmed" },
						})
						return proof
					}),
				)
				yield* rememberApps(proof.scope)
				return proof
			}),
		relinquish: (owner, id) =>
			Effect.gen(function* () {
				const proof = yield* ownProof(owner, id)
				return yield* records.transaction(
					scopeKey(proof.value.scope),
					Effect.gen(function* () {
						const current = yield* ownProof(owner, id)
						if (current.value.status === "Relinquished") return current.value
						const value: Api.Proof = {
							...current.value,
							transition: current.value.transition + 1,
							status: "Relinquished",
							validUntil: yield* Clock.currentTimeMillis,
							reason: "Relinquished",
						}
						yield* records.proofs.put(id, owner, scopeKey(value.scope), {
							...current,
							value,
						})
						for (const member of yield* records.members.list({ scope: id })) {
							const noticeId = yield* Effect.sync(randomUUID)
							yield* records.notices.put(noticeId, member.owner, "", {
								owner: member.owner,
								value: {
									id: noticeId,
									cardUrl: null,
									kind: "AccessChanged",
									issue: null,
									reason: "SourceProofRelinquished",
									reportId: null,
									createdAt: value.validUntil,
									readAt: null,
								},
							})
						}

						return value
					}),
				)
			}),
	})
})
export const layer = Layer.effect(DeveloperAccess, make)
