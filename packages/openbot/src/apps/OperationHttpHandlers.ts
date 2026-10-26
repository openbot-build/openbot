import {
	ChatConflict,
	ExperienceStorageUnavailable,
	Identity,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredInvocations from "./StoredInvocations.ts"
import { Operations } from "./Operations.ts"
import { ownerKey } from "./StoredConnections.ts"
import { Backend } from "../app/Backend.ts"
import * as Failures from "../app/Failures.ts"
import type * as Chats from "../chats/Chats.ts"
import * as Db from "../database/Database.ts"

const conflict = () =>
	ChatConflict.make({
		message: "The Chat of the operation is not there, or it runs another Turn.",
	})
/**
 * A missing or busy Chat is a conflict for this endpoint. A storage failure
 * is logged and becomes `ExperienceStorageUnavailable`.
 */
const fromChats = <A, R>(self: Effect.Effect<A, Chats.ServiceError, R>) =>
	self.pipe(
		Failures.replaceTag(
			"ChatStorageUnavailable",
			"OpenBot could not read the Chat of an App operation",
			() => ExperienceStorageUnavailable.make({}),
		),
		Effect.catchTags({
			ChatNotFound: () => Effect.fail(conflict()),
			ChatConflict: () => Effect.fail(conflict()),
			// Reading a Chat or a Turn does not check models. Keep the old answer if it comes.
			ChatModelInvalid: () => Effect.fail(conflict()),
		}),
	)

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
						const chats = yield* backend
							.forCaller(identity)
							.pipe(
								Failures.replace(
									"OpenBot could not open the Chats of a member",
									() => ExperienceStorageUnavailable.make({}),
								),
							)
						const view = yield* chats.get(operation.chat).pipe(fromChats)
						yield* chats.turn(operation.chat, operation.turn).pipe(fromChats)
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
