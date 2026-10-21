import { createHash, timingSafeEqual } from "node:crypto"
import { ExecutionApi } from "@openbot-build/platform-api"
import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AuthorizationRepository } from "../apps/AuthorizationRepository.ts"
import { accountId } from "./OwnedWrites.ts"
import { Backend } from "../app/Backend.ts"
import { ExecutionFence, type Options } from "./ExecutionFence.ts"

const Checked = Schema.Struct({
	allowed: Schema.Boolean,
	epoch: Schema.Int,
	phase: Schema.String,
	migrationId: Schema.String,
})
export const layer = (options?: Options) =>
	options === undefined
		? Layer.empty
		: Layer.unwrap(
				Effect.gen(function* () {
					const authorizations = yield* AuthorizationRepository
					const backend = yield* Backend
					const fence = yield* ExecutionFence
					const expected = createHash("sha256")
						.update("Bearer " + Redacted.value(options.token))
						.digest()
					return Layer.merge(
						HttpRouter.add(
							"POST",
							ExecutionApi.DrainPath,
							Effect.gen(function* () {
								const request = yield* HttpServerRequest.HttpServerRequest
								const actual = createHash("sha256")
									.update(request.headers["authorization"] ?? "")
									.digest()
								if (!timingSafeEqual(expected, actual))
									return HttpServerResponse.empty({ status: 401 })
								const input = yield* request.json.pipe(
									Effect.flatMap(
										Schema.decodeUnknownEffect(ExecutionApi.DrainRequest),
									),
								)
								const checked = yield* Effect.tryPromise(async (signal) => {
									const response = await fetch(
										new URL("/internal/execution/drain-check", options.origin),
										{
											method: "POST",
											headers: {
												authorization:
													"Bearer " + Redacted.value(options.token),
												"content-type": "application/json",
											},
											body: JSON.stringify({
												...input,
												backend: options.backend,
											}),
											signal: AbortSignal.any([
												signal,
												AbortSignal.timeout(10000),
											]),
											redirect: "error",
										},
									)
									if (!response.ok) throw new Error("Drain authority rejected")
									return response.json()
								}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Checked)))
								if (
									!checked.allowed ||
									checked.epoch !== input.epoch ||
									checked.phase !== "DRAINING" ||
									checked.migrationId !== input.migrationId ||
									backend.drain === undefined
								)
									return HttpServerResponse.empty({ status: 409 })
								const leases = yield* fence.active(input.accountId)
								if (leases > 0)
									return HttpServerResponse.jsonUnsafe({
										...input,
										drained: false,
										activeExecutions: leases,
									})
								const state = yield* backend.drain(
									input.accountId,
									input.sourceTenantId,
								)
								const remaining = yield* fence.active(input.accountId)
								return HttpServerResponse.jsonUnsafe({
									...input,
									drained: state.drained && remaining === 0,
									activeExecutions: state.activeExecutions + remaining,
								})
							}).pipe(
								Effect.orElseSucceed(() =>
									HttpServerResponse.empty({ status: 503 }),
								),
							),
						),
						HttpRouter.add(
							"POST",
							ExecutionApi.AuthorizationOwnerPath,
							Effect.gen(function* () {
								const request = yield* HttpServerRequest.HttpServerRequest
								const actual = createHash("sha256")
									.update(request.headers["authorization"] ?? "")
									.digest()
								if (!timingSafeEqual(expected, actual))
									return HttpServerResponse.empty({ status: 401 })
								const input = yield* request.json.pipe(
									Effect.flatMap(
										Schema.decodeUnknownEffect(
											ExecutionApi.AuthorizationOwnerRequest,
										),
									),
								)
								const record = yield* authorizations.get(input.flowId)
								const id = accountId(record.owner)
								if (id.length === 0)
									return HttpServerResponse.empty({ status: 404 })
								return HttpServerResponse.jsonUnsafe({ accountId: id })
							}).pipe(
								Effect.catchTag("ExperienceNotFound", () =>
									Effect.succeed(HttpServerResponse.empty({ status: 404 })),
								),
								Effect.orElseSucceed(() =>
									HttpServerResponse.empty({ status: 503 }),
								),
							),
						),
					)
				}),
			)
