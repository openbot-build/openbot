import { createHash, timingSafeEqual } from "node:crypto"
import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Barrier } from "./Barrier.ts"
import type { Options } from "../execution/ExecutionFence.ts"
const Input = Schema.Struct({
	migrationId: Schema.NonEmptyString,
	epoch: Schema.Natural,
	challenge: Schema.String.check(
		Schema.isMinLength(32),
		Schema.isMaxLength(128),
	),
})
const Checked = Schema.Struct({
	allowed: Schema.Boolean,
	epoch: Schema.Natural,
	phase: Schema.String,
	migrationId: Schema.String,
})
export const layer = (options?: Options) =>
	options === undefined
		? Layer.empty
		: Layer.unwrap(
				Effect.gen(function* () {
					const barrier = yield* Barrier
					const expected = createHash("sha256")
						.update("Bearer " + Redacted.value(options.token))
						.digest()
					return Layer.mergeAll(
						HttpRouter.add(
							"POST",
							"/internal/auth/drain",
							Effect.gen(function* () {
								const request = yield* HttpServerRequest.HttpServerRequest
								if (
									!timingSafeEqual(
										expected,
										createHash("sha256")
											.update(request.headers["authorization"] ?? "")
											.digest(),
									)
								)
									return HttpServerResponse.empty({ status: 401 })
								const input = yield* request.json.pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(Input)),
								)
								const checked = yield* Effect.tryPromise(async (signal) => {
									const response = await fetch(
										new URL("/internal/auth/drain-check", options.origin),
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
									if (!response.ok) throw new Error("Auth drain rejected")
									return response.json()
								}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Checked)))
								if (
									!checked.allowed ||
									checked.epoch !== input.epoch ||
									checked.migrationId !== input.migrationId ||
									checked.phase !== "DRAINING"
								)
									return HttpServerResponse.empty({ status: 409 })
								const activeAuthRequests = yield* barrier.active
								const attestation = yield* barrier.attest(input.challenge)
								return HttpServerResponse.jsonUnsafe({
									...input,
									backend: options.backend,
									drained: activeAuthRequests === 0,
									activeAuthRequests,
									...attestation,
								})
							}).pipe(
								Effect.orElseSucceed(() =>
									HttpServerResponse.empty({ status: 503 }),
								),
							),
						),
						HttpRouter.add(
							"POST",
							"/internal/auth/session",
							Effect.gen(function* () {
								const request = yield* HttpServerRequest.HttpServerRequest
								if (
									!timingSafeEqual(
										expected,
										createHash("sha256")
											.update(request.headers["authorization"] ?? "")
											.digest(),
									)
								)
									return HttpServerResponse.empty({ status: 401 })
								const result = yield* barrier.readSession(
									new Headers({ cookie: request.headers["cookie"] ?? "" }),
								)
								return HttpServerResponse.fromWeb(
									new Response(
										JSON.stringify({ accountId: result.accountId }),
										{
											status: 200,
											headers: [
												["content-type", "application/json"],
												["cache-control", "no-store"],
												...result.setCookies.map(
													(value) => ["set-cookie", value] as [string, string],
												),
											],
										},
									),
								)
							}).pipe(
								Effect.orElseSucceed(() =>
									HttpServerResponse.empty({ status: 503 }),
								),
							),
						),
						HttpRouter.add(
							"POST",
							"/internal/auth/revocation-status",
							Effect.uninterruptible(
								Effect.gen(function* () {
									const request = yield* HttpServerRequest.HttpServerRequest
									if (
										!timingSafeEqual(
											expected,
											createHash("sha256")
												.update(request.headers["authorization"] ?? "")
												.digest(),
										)
									)
										return HttpServerResponse.empty({ status: 401 })
									const input = yield* request.json.pipe(
										Effect.flatMap(
											Schema.decodeUnknownEffect(
												Schema.Struct({
													epoch: Schema.Natural,
													leaseId: Schema.NonEmptyString,
													retry: Schema.optionalKey(Schema.Boolean),
												}),
											),
										),
									)
									const checked = yield* Effect.tryPromise(async (signal) => {
										const response = await fetch(
											new URL(
												"/internal/auth/revocation-status-check",
												options.origin,
											),
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
										if (!response.ok)
											throw new Error("Auth revocation reconciliation rejected")
										return response.json()
									}).pipe(
										Effect.flatMap(
											Schema.decodeUnknownEffect(
												Schema.Struct({
													allowed: Schema.Boolean,
													epoch: Schema.Natural,
													accountId: Schema.NonEmptyString,
													credentialDigest: Schema.String,
												}),
											),
										),
									)
									if (!checked.allowed)
										return HttpServerResponse.empty({ status: 409 })
									return HttpServerResponse.jsonUnsafe({
										revoked: yield* barrier.revocationStatus({
											...checked,
											retry: input.retry === true,
										}),
									})
								}),
							).pipe(
								Effect.orElseSucceed(() =>
									HttpServerResponse.empty({ status: 503 }),
								),
							),
						),
						HttpRouter.add(
							"POST",
							"/internal/auth/revoke",
							Effect.uninterruptible(
								Effect.gen(function* () {
									const request = yield* HttpServerRequest.HttpServerRequest
									if (
										!timingSafeEqual(
											expected,
											createHash("sha256")
												.update(request.headers["authorization"] ?? "")
												.digest(),
										)
									)
										return HttpServerResponse.empty({ status: 401 })
									const input = yield* request.json.pipe(
										Effect.flatMap(
											Schema.decodeUnknownEffect(
												Schema.Struct({
													epoch: Schema.Natural,
													leaseId: Schema.NonEmptyString,
												}),
											),
										),
									)
									const checked = yield* Effect.tryPromise(async (signal) => {
										const response = await fetch(
											new URL(
												"/internal/auth/revocation-check",
												options.origin,
											),
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
										if (!response.ok)
											throw new Error("Auth revocation rejected")
										return response.json()
									}).pipe(
										Effect.flatMap(
											Schema.decodeUnknownEffect(
												Schema.Struct({
													allowed: Schema.Boolean,
													epoch: Schema.Natural,
													accountId: Schema.NonEmptyString,
													credentialDigest: Schema.String,
												}),
											),
										),
									)
									if (!checked.allowed || checked.epoch !== input.epoch)
										return HttpServerResponse.empty({ status: 409 })
									// The gateway retains this durable lease until the complete response arrives.
									// Client cancellation cannot interrupt a database removal or release its fence.
									const setCookies = yield* barrier.revokeSession({
										...checked,
										headers: new Headers({
											cookie: request.headers["cookie"] ?? "",
										}),
									})
									return HttpServerResponse.fromWeb(
										new Response(null, {
											status: 204,
											headers: [
												["cache-control", "no-store"],
												...setCookies.map(
													(value) => ["set-cookie", value] as [string, string],
												),
											],
										}),
									)
								}),
							).pipe(
								Effect.orElseSucceed(() =>
									HttpServerResponse.empty({ status: 503 }),
								),
							),
						),
					)
				}),
			)
