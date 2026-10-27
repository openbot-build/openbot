import { assert } from "@effect/vitest"
import { ComputersApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import { Effect, Option, Stream } from "effect"
import { Sse } from "effect/encoding"
import type { HttpMethod } from "effect/http"
import type { Redacted } from "effect"
import { Caller } from "@openbot-build/openbot/testing"

export type Send = (
	credential: Redacted.Redacted<string>,
	path: string,
	method?: HttpMethod.HttpMethod,
	payload?: unknown,
) => Caller.Call
/** Check the receipt, then read the saved final state through the public event stream. */
export const finished = (
	send: Send,
	credential: Redacted.Redacted<string>,
	call: Caller.Call,
	expected: Execution.Status = "completed",
) =>
	Effect.gen(function* () {
		const receipt = yield* call.pipe(
			Effect.flatMap(Caller.json(Execution.Receipt, 202)),
		)
		const response = yield* send(
			credential,
			`/v1/executions/${receipt.executionId}/observe?afterSequence=0`,
		)
		assert.equal(response.status, 200)
		const ending = yield* response.stream.pipe(
			Stream.decodeText(),
			Stream.pipeThroughChannel(Sse.decodeDataSchema(Execution.Event)),
			Stream.map((event) => event.data),
			Stream.filter(
				(event) =>
					event.body._tag === "State" &&
					(Execution.isTerminal(event.body.status) ||
						event.body.status === "outcome_unknown"),
			),
			Stream.runHead,
		)
		assert.ok(Option.isSome(ending))
		const saved = yield* send(
			credential,
			`/v1/executions/${receipt.executionId}`,
		).pipe(Effect.flatMap(Caller.json(Execution.Record)))
		assert.equal(saved.status, expected)
		return { receipt, saved }
	})
export const changed = (
	send: Send,
	credential: Redacted.Redacted<string>,
	call: Caller.Call,
) =>
	Effect.gen(function* () {
		const { saved } = yield* finished(send, credential, call)
		return yield* send(credential, `/v1/computers/${saved.resource.id}`).pipe(
			Effect.flatMap(Caller.json(ComputersApi.Computer)),
		)
	})
