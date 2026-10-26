import { assert, it } from "@effect/vitest"
import { Model, Operation, Provider } from "@openbot-build/core"
import { Effect, Schema } from "effect"
import { expectTypeOf } from "vitest"
import {
	ComputerSessionNotFound,
	ConnectorSessionId,
	SessionOutput,
} from "../src/ComputersApi.ts"
import { AppOperationId } from "../src/AppExecution.ts"
import { AppViewId } from "../src/AppViewsApi.ts"
import { ConnectionId, ManualConnectionRequest } from "../src/ConnectionsApi.ts"
import { Model as ModelView, ModelProvider } from "../src/ModelProvidersApi.ts"

it.effect("record IDs keep their string value and have distinct types", () =>
	Effect.gen(function* () {
		expectTypeOf<
			NonNullable<typeof SessionOutput.Type.session>
		>().toEqualTypeOf<ConnectorSessionId>()
		expectTypeOf<
			ComputerSessionNotFound["id"]
		>().toEqualTypeOf<ConnectorSessionId>()
		expectTypeOf<ConnectionId>().not.toEqualTypeOf<AppViewId>()
		expectTypeOf<AppOperationId>().not.toEqualTypeOf<Operation.Id>()
		expectTypeOf<typeof ModelView.Type.id>().toEqualTypeOf<Model.Id>()
		expectTypeOf<typeof ModelProvider.Type.id>().toEqualTypeOf<Provider.Id>()
		const value = yield* Schema.decodeEffect(ConnectionId)("connection-1")
		assert.strictEqual(
			yield* Schema.encodeEffect(ConnectionId)(value),
			"connection-1",
		)
		yield* Effect.flip(Schema.decodeEffect(ConnectionId)(""))
	}),
)

it.effect("a manual connection ID must still be a UUID", () =>
	Effect.gen(function* () {
		const decode = Schema.decodeEffect(ManualConnectionRequest.fields.id)
		yield* Effect.flip(decode("connection-1"))
		assert.strictEqual(
			yield* decode("00000000-0000-4000-8000-000000000001"),
			"00000000-0000-4000-8000-000000000001",
		)
	}),
)
