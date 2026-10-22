import { Identity, OpenBotApi, SessionConflict } from "@openbot-build/api"
import { Session } from "@openbot-build/core"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredInvocations from "./StoredInvocations.ts"
import { Operations } from "./Operations.ts"
import { ownerKey } from "./StoredConnections.ts"
import { Backend } from "../app/Backend.ts"
import * as Db from "../database/Database.ts"

export const layer = HttpApiBuilder.group(
	OpenBotApi,
	"appOperations",
	(handlers) =>
		Effect.gen(function* () {
			const db = yield* Db.make
			const secrets = yield* Secrets
			const operations = yield* Operations
			const backend = yield* Backend
			const owner = Effect.map(Identity, ownerKey)
			return handlers
				.handle("get", ({ params }) =>
					Effect.flatMap(owner, (owner) =>
						StoredInvocations.get(db, secrets, owner, params.id),
					),
				)
				.handle("list", ({ params }) =>
					Effect.flatMap(owner, (owner) =>
						StoredInvocations.list(db, secrets, owner, params.sessionId),
					),
				)
				.handle("respond", ({ params, payload }) =>
					Effect.gen(function* () {
						const identity = yield* Identity
						const operation = yield* StoredInvocations.get(
							db,
							secrets,
							ownerKey(identity),
							params.id,
						)
						const conflict = () =>
							SessionConflict.make({
								message:
									"The operation's Session is unavailable or is running another Turn.",
							})
						const sessions = yield* backend
							.forCaller(identity)
							.pipe(Effect.mapError(conflict))
						const view = yield* sessions
							.get(operation.session)
							.pipe(Effect.mapError(conflict))
						if (
							!view.session.turns.some((turn) => turn.id === operation.turn) ||
							(view.activity === "active" &&
								Session.currentTurn(view.session)?.id !== operation.turn)
						)
							return yield* conflict()
						return yield* operations.respond(
							ownerKey(identity),
							params.id,
							payload.round,
							payload.responses,
						)
					}),
				)
		}),
)
