import {
	Identity,
	PlatformApi,
	SessionConflict,
} from "@openbot-build/platform-api"
import { Session } from "@openbot-build/core"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InvocationRepository } from "./InvocationRepository.ts"
import { Operations } from "./Operations.ts"
import { ownerKey } from "./Repository.ts"
import { Backend } from "../app/Backend.ts"

export const layer = HttpApiBuilder.group(
	PlatformApi,
	"appOperations",
	(handlers) =>
		Effect.gen(function* () {
			const records = yield* InvocationRepository
			const operations = yield* Operations
			const backend = yield* Backend
			const owner = Effect.map(Identity, ownerKey)
			return handlers
				.handle("get", ({ params }) =>
					Effect.flatMap(owner, (owner) => records.get(owner, params.id)),
				)
				.handle("list", ({ params }) =>
					Effect.flatMap(owner, (owner) =>
						records.list(owner, params.sessionId),
					),
				)
				.handle("respond", ({ params, payload }) =>
					Effect.gen(function* () {
						const identity = yield* Identity
						const operation = yield* records.get(ownerKey(identity), params.id)
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
