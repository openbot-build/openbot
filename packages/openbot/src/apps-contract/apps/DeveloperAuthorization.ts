import { Developers } from "@openbot-build/domain"
import { Discovery } from "@openbot-build/protocol"
import { and, eq, gt, inArray, ne } from "drizzle-orm"
import { Array as Arr, Clock, Effect, Match } from "effect"
import {
	developerMembers,
	developerProofs,
} from "../../server-database/Schema.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Db from "../../server-database/Database.ts"

/** A proof in these states still gives access. */
const usableStatus = [
	"Confirmed",
	"Unconfirmed",
] as const satisfies ReadonlyArray<Developers.Proof["status"]>

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

export { usableStatus, covers }
