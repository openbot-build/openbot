import { AppCalls } from "@openbot-build/domain"
import { Effect, Layer, Schema } from "effect"
import {
	appConnections,
	appInvocations,
} from "@openbot-build/server-database/Schema"
import * as Db from "@openbot-build/server-database/Database"
import { storage } from "@openbot-build/server-execution/execution/Store"
import { Secrets } from "@openbot-build/server-kernel/secrets/Secrets"
import * as StoredConnections from "@openbot-build/apps-contract/apps/StoredConnections"
import * as StoredInvocations from "@openbot-build/apps-contract/apps/StoredInvocations"
import { AppApprovals } from "@openbot-build/apps-contract/apps/AppApprovals"
export { AppApprovals } from "@openbot-build/apps-contract/apps/AppApprovals"
export type { Service } from "@openbot-build/apps-contract/apps/AppApprovals"

const sameSource = Schema.toEquivalence(AppCalls.Source)

const sameArguments = Schema.toEquivalence(Schema.JsonObject)

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	/** The caller can include this write in its state and notification transaction. */
	const decide = Effect.fn("AppApprovals.decide")(function* (
		owner: string,
		proposal: AppCalls.Invocation,
		allowed: boolean,
	) {
		return yield* db.transaction((tx) =>
			Effect.gen(function* () {
				const connection = (yield* tx
					.select()
					.from(appConnections)
					.where(
						StoredConnections.connectionWhere(
							owner,
							proposal.source.connectionId,
						),
					)
					.for("share"))[0]
				if (
					connection === undefined ||
					connection.revision !== proposal.source.revision
				)
					return "Changed" as const
				const currentConnection = yield* StoredConnections.openRecord(
					secrets,
					owner,
					connection.id,
					connection.body,
				)
				if (
					currentConnection.connection.state !== "Enabled" ||
					currentConnection.revision !== proposal.source.revision
				)
					return "Changed" as const
				const row = (yield* tx
					.select()
					.from(appInvocations)
					.where(StoredInvocations.where(owner, proposal.id))
					.for("update"))[0]
				if (row === undefined) return "Changed" as const
				const current = yield* StoredInvocations.open(secrets, row)
				if (
					current.chat !== proposal.chat ||
					current.turn !== proposal.turn ||
					current.callId !== proposal.callId ||
					current.toolName !== proposal.toolName ||
					current.round !== proposal.round ||
					!sameSource(current.source, proposal.source) ||
					!sameArguments(current.arguments, proposal.arguments)
				)
					return "Changed" as const
				const status = allowed ? "Approved" : "Rejected"
				if (current.status === status) return "Saved" as const
				if (current.status !== "PendingApproval") return "Changed" as const
				const body = yield* StoredInvocations.seal(secrets, owner, {
					...current,
					status,
				})
				yield* tx
					.update(appInvocations)
					.set({ status, body })
					.where(StoredInvocations.where(owner, proposal.id))
				return "Saved" as const
			}),
		)
	}, storage)
	return AppApprovals.of({ decide })
})

export const layer = Layer.effect(AppApprovals, make)
