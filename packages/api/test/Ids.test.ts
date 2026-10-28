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
import {
	ConnectionId,
	ConnectionRequest,
	ManualConnectionRequest,
	RevalidationRequest,
} from "../src/ConnectionsApi.ts"
import { Model as ModelView, ModelProvider } from "../src/ModelProvidersApi.ts"
import { DeveloperApi } from "../src/DeveloperApi.ts"
import { UserTokensApi } from "../src/UserTokensApi.ts"

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

it.effect("connection drafts accept UUID v4 and v7 IDs", () =>
	Effect.gen(function* () {
		for (const schema of [
			ConnectionRequest.fields.draftId,
			RevalidationRequest.fields.draftId,
		]) {
			const decode = Schema.decodeEffect(schema)
			yield* Effect.flip(decode("draft-1"))
			for (const id of [
				"00000000-0000-4000-8000-000000000001",
				"019a72a7-0000-7000-8000-000000000001",
			])
				assert.strictEqual(yield* decode(id), id)
		}
	}),
)

it("stored UUID IDs reject bad paths and cursors before a database query", () => {
	const endpoints = DeveloperApi.endpoints
	for (const endpoint of [
		endpoints.getClaim,
		endpoints.verifyClaim,
		endpoints.revokeClaim,
		endpoints.getProof,
		endpoints.verifyProof,
		endpoints.relinquish,
		endpoints.members,
		endpoints.invite,
		endpoints.changeMember,
		endpoints.removeMember,
		endpoints.report,
		endpoints.compare,
		endpoints.deleteReport,
		endpoints.indexingRequest,
	]) {
		assert.ok(endpoint.params !== undefined)
		const valid = Schema.is(endpoint.params)
		assert.isFalse(valid({ id: "missing" }))
		assert.isTrue(valid({ id: "00000000-0000-4000-8000-000000000001" }))
		assert.isTrue(valid({ id: "019a2b10-9c20-7000-8000-000000000001" }))
	}
	const tokens = UserTokensApi.endpoints.revokeToken.params
	assert.ok(tokens !== undefined)
	assert.isFalse(Schema.is(tokens)({ tokenId: "missing" }))
	assert.isTrue(
		Schema.is(tokens)({ tokenId: "00000000-0000-4000-8000-000000000001" }),
	)
	const reports = endpoints.personalReports.query
	assert.ok(reports !== undefined)
	assert.isFalse(Schema.is(reports)({ before: "missing" }))
	assert.isTrue(
		Schema.is(reports)({ before: "019a2b10-9c20-7000-8000-000000000001" }),
	)
	const notices = endpoints.readNotification.params
	assert.ok(notices !== undefined)
	assert.isTrue(Schema.is(notices)({ id: "notice-hash" }))
	const invitations = endpoints.invitation.params
	assert.ok(invitations !== undefined)
	assert.isTrue(Schema.is(invitations)({ id: "invitation-secret" }))
})
