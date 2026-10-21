import { InstanceWork } from "./InstanceWork.ts"
import { Barrier } from "../auth/Barrier.ts"
import * as StoredExecutions from "./StoredExecutions.ts"
import { ExecutionApi } from "@openbot-build/platform-api"
import { createHash, timingSafeEqual } from "node:crypto"
import { Effect, Layer, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Backend } from "../app/Backend.ts"
import { ExecutionFence, type Options } from "./ExecutionFence.ts"

/** Releases may drain one process, but cannot move in-memory execution to another process. */
export const layer = (options?: Options) =>
	options === undefined
		? Layer.empty
		: Layer.unwrap(
				Effect.gen(function* () {
					const fence = yield* ExecutionFence,
						work = yield* InstanceWork,
						auth = yield* Barrier,
						backend = yield* Backend
					const expected = createHash("sha256")
						.update("Bearer " + Redacted.value(options.token))
						.digest()
					const handler = (action: "quiesce" | "resume" | "status") =>
						Effect.gen(function* () {
							const request = yield* HttpServerRequest.HttpServerRequest
							const received = createHash("sha256")
								.update(request.headers["authorization"] ?? "")
								.digest()
							if (!timingSafeEqual(expected, received))
								return HttpServerResponse.empty({ status: 401 })
							if (action === "quiesce") {
								yield* work.quiesce
								yield* fence.quiesce
							}
							if (action === "resume") {
								yield* fence.resume
								yield* work.resume
							}
							if (backend.status === undefined)
								return HttpServerResponse.empty({ status: 503 })
							// The durable scan is valid only after all writers were already idle.
							// Otherwise a finishing writer could create pending state after its table was read.
							const beforeWork = yield* work.status
							const beforeFence = yield* fence.status
							const beforeAuth = yield* auth.active
							const execution = yield* backend.status
							const persisted = yield* StoredExecutions.pending(options)
							const state = yield* fence.status
							const instance = yield* work.status
							const authLeases = yield* auth.active
							return HttpServerResponse.jsonUnsafe({
								...state,
								...execution,
								persistedPending: persisted,
								instanceTasks: instance.activeTasks,
								authLeases,
								drained:
									state.quiesced &&
									beforeWork.activeTasks === 0 &&
									beforeFence.activeLeases === 0 &&
									beforeAuth === 0 &&
									instance.quiesced &&
									instance.activeTasks === 0 &&
									authLeases === 0 &&
									state.activeLeases === 0 &&
									execution.activeExecutions === 0 &&
									persisted === 0,
							})
						}).pipe(
							Effect.orElseSucceed(() =>
								HttpServerResponse.empty({ status: 503 }),
							),
						)
					return Layer.mergeAll(
						HttpRouter.add(
							"POST",
							ExecutionApi.QuiescePath,
							handler("quiesce"),
						),
						HttpRouter.add("POST", ExecutionApi.ResumePath, handler("resume")),
						HttpRouter.add("POST", ExecutionApi.StatusPath, handler("status")),
					)
				}),
			)
