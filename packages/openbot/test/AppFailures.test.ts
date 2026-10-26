import { assert, it } from "@effect/vitest"
import {
	type AppExecution,
	ConnectionsApi,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Client, Store } from "@openbot-build/protocol"
import { Effect } from "effect"
import { failed } from "../src/apps/AppResults.ts"
import { toStoreError } from "../src/apps/ProtocolStores.ts"

const source: AppExecution.Source = {
	connectionId: ConnectionsApi.ConnectionId.make("connection-1"),
	connectionName: "Documents",
	cardUrl: "https://apps.example.com/card",
	appName: "Documents",
	remoteIndex: 0,
	revision: 1,
	kind: "prompt",
	name: "summary",
}

it.effect(
	"a failed App call gives the model the issue of its client error",
	() =>
		Effect.gen(function* () {
			const issue = "Prompt arguments do not match the current declaration"
			const result = yield* failed({
				source,
				error: Client.ClientError.make({ reason: "Schema", issue }),
			})
			assert.strictEqual(result._tag, "Failed")
			assert.strictEqual(result.reason, "Schema")
			assert.include(result.message, issue)
			// The call did not reach the App, so the text must not blame its result.
			assert.notInclude(result.message, "valid result")
		}),
)

it.effect(
	"a stored connection failure becomes a store error that keeps its cause",
	() =>
		Effect.sync(() => {
			const toError = toStoreError("Owned App storage")
			const missing = toError(ExperienceNotFound.make({ id: "connection-1" }))
			assert.strictEqual(missing.reason, "Missing")
			assert.strictEqual(missing.operation, "Owned App storage")
			const storage = ExperienceStorageUnavailable.make({})
			const unavailable = toError(storage)
			assert.strictEqual(unavailable.reason, "Unavailable")
			assert.strictEqual(unavailable.cause, storage)
			const conflict = ConnectionsApi.ConnectionConflict.make({
				reason: "LimitReached",
				message: "The account has too many connections.",
			})
			assert.strictEqual(toError(conflict).reason, "Unavailable")
			assert.strictEqual(toError(conflict).cause, conflict)
			const stored = Store.StoreError.make({
				reason: "AlreadyExists",
				operation: "Save an App",
			})
			assert.strictEqual(toError(stored), stored)
		}),
)
