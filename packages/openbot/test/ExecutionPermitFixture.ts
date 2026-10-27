import { Execution } from "@openbot-build/domain"
import { Effect, Layer, Redacted, String as Str } from "effect"
import * as Records from "../src/errors/Records.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Permits from "../src/execution/Permits.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"

export const actor = {
	kind: "member",
	organizationId: "org",
	userId: "user",
} as const

export const services = Observation.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(Store.layer, Records.layer)),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
)

export const start = Effect.fn(function* (namespace: string) {
	const store = yield* Store.Store
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make("start"),
		{
			workflow: "permit-test",
			resource: { kind: "Test", id: namespace },
			identity: { owner: actor, actor },
			input: null,
		},
	)
	return yield* store.takeOver({ namespace, id: receipt.executionId })
})

export const pool = (id: string): Permits.Pool => ({
	scope: "org",
	resource: { kind: "Test", id },
})
