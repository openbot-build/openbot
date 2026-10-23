import { ChatConflict, Identity, OpenBotApi } from "@openbot-build/api"
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
						StoredInvocations.list(db, secrets, owner, params.chatId),
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
							ChatConflict.make({
								message:
									"The Chat of the operation is not there, or it runs another Turn.",
							})
						const chats = yield* backend
							.forCaller(identity)
							.pipe(Effect.mapError(conflict))
						const view = yield* chats
							.get(operation.chat)
							.pipe(Effect.mapError(conflict))
						yield* chats
							.turn(operation.chat, operation.turn)
							.pipe(Effect.mapError(conflict))
						if (view.activity === "active" && view.turn?.id !== operation.turn)
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
