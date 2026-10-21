import { PgClient } from "@effect/sql-pg"
import { Session, Turn } from "@openbot-build/core"
import { Data, Effect, Redacted, Schema } from "effect"
import type { Options } from "./ExecutionFence.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredInvocations from "../apps/StoredInvocations.ts"

export class StoredOwnerMismatch extends Data.TaggedError(
	"StoredOwnerMismatch",
)<{}> {}

/** Inspect durable state without opening a runtime or replaying any model or tool. */
const stored = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const sessions = yield* sql<{
		namespace: string
		body: string
	}>`SELECT namespace,body FROM openbot_session_references`
	const operations = yield* sql<{
		owner: string
		id: string
		session: string
		status: string
		body: string
	}>`SELECT owner,id,session,status,body FROM openbot_app_invocations WHERE status NOT IN ('Completed','Failed','Rejected')`
	const authorizations = yield* sql<{
		owner: string
	}>`SELECT owner FROM openbot_app_authorizations WHERE status NOT IN ('Succeeded','Cancelled','Failed') AND NOT(status='Waiting' AND callback IS NULL AND expires_at<=extract(epoch FROM clock_timestamp())*1000)`
	const developer = yield* sql<{
		owner: string
	}>`SELECT owner FROM openbot_developer_tests WHERE status NOT IN ('Succeeded','Failed','Cancelled','Interrupted') OR cleanup='Pending' OR cleanup_lease_until<>0 UNION ALL SELECT owner FROM openbot_developer_test_flows WHERE status IN ('Received','Exchanging')`
	const publicWork = yield* sql<{
		count: number
	}>`SELECT ((SELECT count(*) FROM openbot_app_index_jobs WHERE claim IS NOT NULL OR lease_until <> 0) + (SELECT count(*) FROM openbot_developer_apps WHERE lease_until <> 0))::int AS count`
	const counts = new Map<string, number>()
	const references = new Map<string, Session.Ref>()
	// Request owners are approvers. The chain names the person whose work waits.
	// Agent records are plain JSON, unlike encrypted App invocation bodies.
	const agents = yield* sql<{
		organization_id: string
		kind: string
		owner: string
		body: string
	}>`
          SELECT organization_id,kind,owner,body FROM openbot_agent_records
          WHERE (kind='delegation' AND status <> 'resolved')
             OR (kind='request' AND status <> 'resolved')
        `
	for (const row of sessions) {
		const ref = yield* Schema.decodeEffect(Schema.fromJsonString(Session.Ref))(
			row.body,
		)
		const turn = Session.currentTurn(ref)
		references.set(JSON.stringify([row.namespace, ref.id]), ref)
		if (
			ref.pending.length > 0 ||
			(turn !== undefined && !Turn.isTerminal(turn.status))
		)
			counts.set(row.namespace, (counts.get(row.namespace) ?? 0) + 1)
	}
	const activeOperations: Array<{ readonly owner: string }> = []
	for (const row of operations) {
		// Sending and unknown outcomes always need an operator, even if the Turn ended.
		if (row.status === "Sending" || row.status === "OutcomeUnknown") {
			activeOperations.push(row)
			continue
		}
		const operation = yield* StoredInvocations.decodeBody(yield* Secrets, row)
		const ref = references.get(JSON.stringify([row.owner, row.session]))
		const origins =
			ref?.turns.filter(
				(turn) => turn.id === operation.turn && turn.session === row.session,
			) ?? []
		// Only an intact, unanswered proposal for a proven terminal Turn is history.
		// Missing Sessions and unknown result states remain blocked for review.
		const historical =
			(row.status === "PendingApproval" || row.status === "Approved") &&
			operation.id === row.id &&
			operation.session === row.session &&
			operation.status === row.status &&
			operation.result === null &&
			origins.length === 1 &&
			Turn.isTerminal(origins[0]!.status)
		if (!historical) activeOperations.push(row)
	}
	for (const row of [...activeOperations, ...authorizations, ...developer]) {
		const owner = yield* Schema.decodeEffect(
			Schema.fromJsonString(
				Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString]),
			),
		)(row.owner)
		const namespace = JSON.stringify(owner)
		counts.set(namespace, (counts.get(namespace) ?? 0) + 1)
	}
	for (const row of agents) {
		const owner =
			row.kind === "delegation"
				? {
						organizationId: row.organization_id,
						userId: (yield* Schema.decodeEffect(
							Schema.fromJsonString(
								Schema.Struct({ userId: Schema.NonEmptyString }),
							),
						)(row.body)).userId,
					}
				: (yield* Schema.decodeEffect(
						Schema.fromJsonString(
							Schema.Struct({
								chain: Schema.Struct({
									organizationId: Schema.NonEmptyString,
									userId: Schema.NonEmptyString,
								}),
							}),
						),
					)(row.body)).chain
		if (
			owner.organizationId !== row.organization_id ||
			(row.kind === "delegation" && owner.userId !== row.owner)
		)
			return yield* new StoredOwnerMismatch()
		const namespace = JSON.stringify([owner.organizationId, owner.userId])
		counts.set(namespace, (counts.get(namespace) ?? 0) + 1)
	}
	return { counts, publicWork: publicWork[0]?.count ?? 0 }
})

/** Read one account without creating a runtime or renewing an execution epoch. */
export const forNamespace = (namespace: string) =>
	stored.pipe(Effect.map(({ counts }) => counts.get(namespace) ?? 0))

/** Count unfinished work still assigned here, including after restart. */
export const pending = (options?: Options) =>
	Effect.gen(function* () {
		const { counts, publicWork } = yield* stored
		if (options === undefined)
			return (
				publicWork + [...counts.values()].reduce((sum, value) => sum + value, 0)
			)
		let count = publicWork
		for (const [namespace, total] of counts) {
			const assigned = yield* Effect.tryPromise(async (signal) => {
				const response = await fetch(
					new URL("/internal/execution/assignment", options.origin),
					{
						method: "POST",
						redirect: "error",
						headers: {
							authorization: "Bearer " + Redacted.value(options.token),
							"content-type": "application/json",
						},
						body: JSON.stringify({ namespace, backend: options.backend }),
						signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
					},
				)
				if (!response.ok) throw new Error("Execution assignment unavailable")
				return response.json()
			}).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.Struct({ assigned: Schema.Boolean }),
					),
				),
			)
			if (assigned.assigned) count += total
		}
		return count
	})
