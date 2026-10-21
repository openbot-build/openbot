import {
	SessionStorageUnavailable,
	SessionConflict,
	Identity,
	SessionsApi,
	PlatformApi,
} from "@openbot-build/platform-api"
import { Effect, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/http-api"
import { Backend } from "../app/Backend.ts"

type Request<K extends keyof typeof SessionsApi.endpoints> = Omit<
	HttpApiEndpoint.Request<(typeof SessionsApi.endpoints)[K]>,
	"endpoint" | "group" | "request"
>
/** The Sessions of the calling tenant. */
const currentSessions = Effect.map(Backend, (backend) =>
	Effect.flatMap(Identity, (caller) =>
		backend
			.get(caller.tenantId, caller)
			.pipe(Effect.mapError(() => SessionStorageUnavailable.make({}))),
	),
)
const implementations = Effect.gen(function* () {
	const current = yield* currentSessions
	const model = yield* Effect.serviceOption(LanguageModel.LanguageModel)
	/** Give the host model to operations that may run one. */
	const withModel = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Option.match(model, {
			onNone: () => effect,
			onSome: (model) =>
				Effect.provideService(effect, LanguageModel.LanguageModel, model),
		})
	return {
		selectSessionMode: ({ params, payload }: Request<"selectSessionMode">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.selectMode(params.sessionId, payload),
			),
		sessionVersions: ({ params }: Request<"sessionVersions">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.versions(params.sessionId),
			),
		sessionModels: ({ params }: Request<"sessionModels">) =>
			Effect.flatMap(current, (sessions) => sessions.models(params.sessionId)),
		selectSessionModel: ({ params, payload }: Request<"selectSessionModel">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.selectModel(params.sessionId, payload),
			),
		sessionMemory: ({ params }: Request<"sessionMemory">) =>
			Effect.flatMap(current, (sessions) => sessions.memory(params.sessionId)),
		updateSessionMemory: ({
			params,
			payload,
		}: Request<"updateSessionMemory">) =>
			Effect.flatMap(current, (sessions) =>
				withModel(sessions.updateMemory(params.sessionId, payload)),
			),
		createSession: ({ payload }: Request<"createSession">) =>
			Effect.flatMap(current, (sessions) => sessions.create(payload)),
		getSession: ({ params }: Request<"getSession">) =>
			Effect.flatMap(current, (sessions) => sessions.get(params.sessionId)),
		listSessions: ({ query }: Request<"listSessions">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.list({
					...(query.archived === undefined
						? {}
						: { archived: query.archived === "true" }),
				}),
			),
		updateSession: ({ params, payload }: Request<"updateSession">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.update(params.sessionId, payload),
			),
		deleteSession: ({ params }: Request<"deleteSession">) =>
			Effect.flatMap(current, (sessions) => sessions.remove(params.sessionId)),
		forkSession: ({ params, payload }: Request<"forkSession">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.fork(params.sessionId, payload),
			),
		sessionHistory: ({ params, query }: Request<"sessionHistory">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.history(params.sessionId, query.version),
			),
		exportSession: ({ params }: Request<"exportSession">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.exportRecord(params.sessionId),
			),
		restoreSession: ({ params, payload }: Request<"restoreSession">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.restore(params.sessionId, payload),
			),
		waitSession: ({ params, query }: Request<"waitSession">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.wait(
					params.sessionId,
					query.after,
					query.timeoutMs,
					query.afterActivity,
				),
			),
		interruptTurn: ({ params }: Request<"interruptTurn">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.interrupt(params.sessionId, params.turnId),
			),
		resumeSession: ({ params }: Request<"resumeSession">) =>
			Effect.flatMap(current, (sessions) => sessions.resume(params.sessionId)),
		updateSessionSettings: ({
			params,
			payload,
		}: Request<"updateSessionSettings">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.settings(params.sessionId, payload),
			),
		sessionTurns: ({ params, query }: Request<"sessionTurns">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.turns(params.sessionId, query),
			),
		getTurn: ({ params }: Request<"getTurn">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.turn(params.sessionId, params.turnId),
			),
		turnItems: ({ params, query }: Request<"turnItems">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.items(params.sessionId, params.turnId, query),
			),
		steerTurn: ({ params, payload }: Request<"steerTurn">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.steer(params.sessionId, params.turnId, payload.input),
			),
		enqueueMessage: ({ params, payload }: Request<"enqueueMessage">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.enqueue(params.sessionId, payload),
			),

		startTurn: ({ params, payload }: Request<"startTurn">) =>
			withModel(
				Effect.gen(function* () {
					const sessions = yield* current
					if (payload.stream === true)
						return yield* sessions.sendStream(params.sessionId, payload)
					return yield* sessions.send(params.sessionId, payload)
				}),
			),
	}
})
export const layerPlatform = HttpApiBuilder.group(
	PlatformApi,
	"sessions",
	(handlers) =>
		Effect.map(implementations, (routes) => handlers.handleAll(routes)),
)

export const layerPlatformApprovals = HttpApiBuilder.group(
	PlatformApi,
	"approvals",
	(handlers) =>
		Effect.gen(function* () {
			const current = yield* currentSessions
			return handlers
				.handle("list", ({ params }) =>
					Effect.flatMap(current, (sessions) =>
						sessions.pendingApprovals(params.sessionId),
					),
				)
				.handle("resolve", ({ params, payload }) =>
					Effect.gen(function* () {
						const sessions = yield* current
						const pending = yield* sessions.pendingApprovals(params.sessionId)
						if (!pending.some((item) => item.approvalId === params.approvalId))
							return yield* SessionConflict.make({
								message: "Approval is not pending on this Session",
							})
						return yield* sessions.approve(params.sessionId, {
							...payload,
							approvalId: params.approvalId,
							turn: params.turnId,
						})
					}),
				)
		}),
)
