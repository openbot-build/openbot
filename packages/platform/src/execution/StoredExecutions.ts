import { PgClient } from "@effect/sql-pg"
import { Session, Turn } from "@openbot-build/core"
import { Effect, Redacted, Schema } from "effect"
import type { Options } from "./ExecutionFence.ts"

/** Inspect durable state without opening a runtime or replaying any model or tool. */
export const pending = (options: Options) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const sessions = yield* sql<{
			namespace: string
			body: string
		}>`SELECT namespace,body FROM openbot_session_references`
		const operations = yield* sql<{
			owner: string
		}>`SELECT owner FROM openbot_app_invocations WHERE status NOT IN ('Completed','Failed','Rejected')`
		const authorizations = yield* sql<{
			owner: string
		}>`SELECT owner FROM openbot_app_authorizations WHERE status NOT IN ('Waiting','Succeeded','Cancelled','Failed')`
		const developer = yield* sql<{
			owner: string
		}>`SELECT owner FROM openbot_developer_records WHERE (kind LIKE '%:test' AND (coalesce(body::jsonb#>>'{value,status}','') NOT IN ('Succeeded','Failed','Cancelled','Interrupted') OR body::jsonb#>>'{value,cleanup}'='Pending' OR coalesce((body::jsonb->>'cleanupLeaseUntil')::numeric,0)<>0)) OR (kind LIKE '%:testFlow' AND body::jsonb#>>'{value,status}' IN ('Received','Exchanging'))`
		const publicWork = yield* sql<{
			count: number
		}>`SELECT ((SELECT count(*) FROM openbot_app_index_jobs WHERE claim IS NOT NULL OR lease_until <> 0) + (SELECT count(*) FROM openbot_developer_records WHERE kind LIKE '%:app' AND coalesce((body::jsonb->>'leaseUntil')::numeric,0) <> 0))::int AS count`
		const counts = new Map<string, number>()
		for (const row of sessions) {
			const ref = yield* Schema.decodeEffect(
				Schema.fromJsonString(Session.Ref),
			)(row.body)
			const turn = Session.currentTurn(ref)
			if (
				ref.pending.length > 0 ||
				(turn !== undefined && !Turn.isTerminal(turn.status))
			)
				counts.set(row.namespace, (counts.get(row.namespace) ?? 0) + 1)
		}
		for (const row of [...operations, ...authorizations, ...developer]) {
			const owner = yield* Schema.decodeEffect(
				Schema.fromJsonString(
					Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString]),
				),
			)(row.owner)
			const namespace = JSON.stringify(owner)
			counts.set(namespace, (counts.get(namespace) ?? 0) + 1)
		}
		let count = publicWork[0]?.count ?? 0
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
