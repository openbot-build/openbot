import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import {
	SessionStorageUnavailable,
	Identity,
	SessionsApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { HttpApiBuilder, type HttpApiEndpoint } from "effect/http-api"
import { Backend } from "../app/Backend.ts"
import { Agents } from "../agents/Agents.ts"
import * as DefaultAgent from "../agents/DefaultAgent.ts"
import { Delegations } from "../agents/Delegations.ts"
import { MemoryAgent } from "../agents/MemoryAgent.ts"

type Request<K extends keyof typeof SessionsApi.endpoints> = Omit<
	HttpApiEndpoint.Request<(typeof SessionsApi.endpoints)[K]>,
	"endpoint" | "group" | "request"
>
/** The Sessions of the calling member. */
const currentSessions = Effect.map(Backend, (backend) =>
	Effect.flatMap(Identity, (caller) =>
		backend
			.forCaller(caller)
			.pipe(Effect.mapError(() => SessionStorageUnavailable.make({}))),
	),
)
const implementations = Effect.gen(function* () {
	const current = yield* currentSessions
	const agents = yield* Agents
	const delegations = yield* Delegations
	const memoryAgent = yield* MemoryAgent
	const services = yield* Effect.context<
		AuthorizationServices | DefaultAgent.Services
	>()
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
		// Reading the Session first checks that the caller may see it.
		sessionConfessions: ({ params }: Request<"sessionConfessions">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* (yield* current).get(params.sessionId)
				return yield* memoryAgent
					.confessions(caller.organizationId, params.sessionId)
					.pipe(Effect.mapError(() => SessionStorageUnavailable.make({})))
			}),
		sessionEnrichments: ({ params }: Request<"sessionEnrichments">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				yield* (yield* current).get(params.sessionId)
				return yield* memoryAgent
					.enrichments(caller.organizationId, params.sessionId)
					.pipe(Effect.mapError(() => SessionStorageUnavailable.make({})))
			}),
		sessionTodos: ({ params }: Request<"sessionTodos">) =>
			Effect.flatMap(current, (sessions) => sessions.todos(params.sessionId)),
		updateSessionTodos: ({ params, payload }: Request<"updateSessionTodos">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.updateTodos(params.sessionId, payload),
			),
		createSession: ({ payload }: Request<"createSession">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const sessions = yield* current
				// Work for an Agent needs the delegate permission on it.
				const agent = yield* (
					payload.agent === undefined
						? DefaultAgent.resolve(caller)
						: agents.access(caller, payload.agent, "agents.delegate")
				).pipe(Effect.provideContext(services))
				return yield* sessions.create({
					agent,
					kind: "direct",
					chain: {
						organizationId: caller.organizationId,
						userId: caller.userId,
						...(caller.tokenId === undefined
							? {}
							: { tokenId: caller.tokenId }),
						agents: [agent.id],
						sessions: [],
					},
					...(payload.title === undefined ? {} : { title: payload.title }),
					...(payload.planApproval === undefined
						? {}
						: { planApproval: payload.planApproval }),
					...(payload.settings === undefined
						? {}
						: { settings: payload.settings }),
				})
			}),
		getSession: ({ params }: Request<"getSession">) =>
			Effect.flatMap(current, (sessions) => sessions.get(params.sessionId)),
		listSessions: ({ query }: Request<"listSessions">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.list({
					...(query.archived === undefined
						? {}
						: { archived: query.archived === "true" }),
					...(query.agent === undefined ? {} : { agent: query.agent }),
					...(query.kind === undefined ? {} : { kind: query.kind }),
				}),
			),
		updateSession: ({ params, payload }: Request<"updateSession">) =>
			Effect.flatMap(current, (sessions) =>
				sessions.update(params.sessionId, payload),
			),
		deleteSession: ({ params }: Request<"deleteSession">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const sessions = yield* current
				yield* sessions.remove(params.sessionId)
				// The Session Agents of a Session live only as long as the Session.
				yield* agents
					.archiveOwnedBy(caller, params.sessionId)
					.pipe(Effect.mapError(() => SessionStorageUnavailable.make({})))
			}),
		sessionDelegations: ({ params }: Request<"sessionDelegations">) =>
			Effect.gen(function* () {
				const caller = yield* Identity
				const sessions = yield* current
				yield* sessions.get(params.sessionId)
				const list = yield* delegations
					.forSession(caller.organizationId, params.sessionId)
					.pipe(Effect.mapError(() => SessionStorageUnavailable.make({})))
				return list.map((stored) => stored.delegation)
			}),
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
	OpenBotApi,
	"sessions",
	(handlers) =>
		Effect.map(implementations, (routes) => handlers.handleAll(routes)),
)
