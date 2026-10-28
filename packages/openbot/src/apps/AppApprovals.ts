import { type Execution, AppCalls } from "@openbot-build/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { appConnections, appInvocations } from "../database/Schema.ts"
import * as Db from "../database/Database.ts"
import { storage } from "../execution/Store.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import * as StoredInvocations from "./StoredInvocations.ts"

const sameSource = Schema.toEquivalence(AppCalls.Source)
const sameArguments = Schema.toEquivalence(Schema.JsonObject)
export interface Service {
	readonly decide: (
		owner: string,
		proposal: AppCalls.Invocation,
		allowed: boolean,
	) => Effect.Effect<"Changed" | "Saved", Execution.StorageError>
}

export class AppApprovals extends Context.Service<AppApprovals, Service>()(
	"@openbot-build/openbot/apps/AppApprovals",
) {}

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
