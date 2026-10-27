import { TestCleanup } from "./TestCleanup.ts"
import { TestCommands } from "./TestCommands.ts"
import { ProofCommands } from "./ProofCommands.ts"
import * as HttpErrors from "../execution/HttpErrors.ts"
import { DeveloperApi as Api, OpenBotApi } from "@openbot-build/api"

import { Identity } from "@openbot-build/domain"
import { Effect, Layer, Option } from "effect"
import * as HttpMiddleware from "../auth/HttpMiddleware.ts"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AppInspections } from "./AppInspections.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { DeveloperMembers } from "./DeveloperMembers.ts"
import { DeveloperReports } from "./DeveloperReports.ts"
import { ownerKey, ownersOf } from "./StoredConnections.ts"
import { DeveloperTests } from "./DeveloperTests.ts"
import { DeveloperIndexing } from "./DeveloperIndexing.ts"
import { DeveloperNotifications } from "./DeveloperNotifications.ts"
import { Auth } from "../auth/Auth.ts"

export const layerPublic = HttpApiBuilder.group(
	OpenBotApi,
	"developerPublic",
	(handlers) =>
		Effect.gen(function* () {
			const inspections = yield* AppInspections
			const tests = yield* DeveloperTests
			const auth = yield* Auth
			const executionErrors = yield* HttpErrors.make
			return handlers
				.handleRaw("authorizationCallback", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const owner = yield* HttpMiddleware.optionalSession(auth).pipe(
							Effect.map(Option.map(ownersOf)),
							// The Auth service logs the cause of each failure.
							Effect.catchTag("AuthUnavailable", () =>
								Effect.fail(Api.DeveloperUnavailable.make({})),
							),
						)
						const receipt = yield* tests.receive(request.url, owner)
						const target =
							"/?" + new URLSearchParams({ developerTest: receipt.testId })
						return HttpServerResponse.empty({
							status: 303,
							headers: {
								// Without a session, the client signs in with Better Auth and then reads the test.
								location: target,
								"cache-control": "no-store",
								"referrer-policy": "no-referrer",
							},
						})
					}).pipe(executionErrors),
				)
				.handle("inspect", ({ payload }) =>
					inspections.inspect(payload.input).pipe(executionErrors),
				)
		}),
).pipe(Layer.provide(HttpMiddleware.layerNoStore))

export const layer = HttpApiBuilder.group(OpenBotApi, "developer", (handlers) =>
	Effect.gen(function* () {
		const access = yield* DeveloperAccess
		const proofs = yield* ProofCommands
		const testCleanup = yield* TestCleanup
		const testCommands = yield* TestCommands
		const members = yield* DeveloperMembers
		const reports = yield* DeveloperReports
		const tests = yield* DeveloperTests
		const owner = Effect.map(Identity, ownerKey)
		const indexing = yield* DeveloperIndexing
		const executionErrors = yield* HttpErrors.make
		const notifications = yield* DeveloperNotifications
		return handlers
			.handle("personalReports", ({ query }) =>
				Effect.flatMap(owner, (value) =>
					reports.personal(value, query.before),
				).pipe(executionErrors),
			)
			.handle("notifications", ({ query }) =>
				Effect.flatMap(owner, (value) =>
					notifications.list(value, query.before),
				).pipe(executionErrors),
			)
			.handle("readNotification", ({ params }) =>
				Effect.flatMap(owner, (value) =>
					notifications.read(value, params.id),
				).pipe(executionErrors),
			)
			.handle("subscriptions", () =>
				Effect.flatMap(owner, notifications.subscriptions).pipe(
					executionErrors,
				),
			)
			.handle("subscribe", ({ payload }) =>
				Effect.flatMap(owner, (value) =>
					notifications.subscribe(value, payload),
				).pipe(executionErrors),
			)
			.handle("requestIndexing", ({ payload }) =>
				Effect.flatMap(Identity, (value) =>
					indexing.request(value, payload.cardUrl, payload.commandKey),
				).pipe(executionErrors),
			)
			.handle("indexingRequests", ({ query }) =>
				Effect.flatMap(owner, (value) =>
					indexing.list(value, query.cardUrl),
				).pipe(executionErrors),
			)
			.handle("indexingRequest", ({ params }) =>
				Effect.flatMap(owner, (value) => indexing.get(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("createTest", ({ payload }) =>
				Effect.flatMap(owner, (value) => tests.create(value, payload)).pipe(
					executionErrors,
				),
			)
			.handle("tests", () =>
				Effect.flatMap(owner, tests.list).pipe(executionErrors),
			)
			.handle("test", ({ params }) =>
				Effect.flatMap(owner, (value) => tests.get(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("configureTest", ({ params, payload }) =>
				Effect.flatMap(owner, (value) =>
					tests.configure(value, params.id, payload),
				).pipe(executionErrors),
			)
			.handle("runTest", ({ params, payload }) =>
				Effect.flatMap(Identity, (value) =>
					testCommands.request(value, params.id, payload.commandKey),
				).pipe(executionErrors),
			)
			.handle("cancelTest", ({ params, payload }) =>
				Effect.flatMap(Identity, (actor) =>
					testCleanup.request(actor, params.id, payload.commandKey, false),
				).pipe(executionErrors),
			)
			.handle("cleanupTest", ({ params, payload }) =>
				Effect.flatMap(Identity, (actor) =>
					testCleanup.request(actor, params.id, payload.commandKey, false),
				).pipe(executionErrors),
			)
			.handle("deleteTest", ({ params, query }) =>
				Effect.flatMap(Identity, (actor) =>
					testCleanup.request(actor, params.id, query.commandKey, true),
				).pipe(executionErrors),
			)
			.handle("authorizeTest", ({ params, payload }) =>
				Effect.flatMap(Identity, (value) =>
					testCommands.prepare(value, params.id, payload, payload.commandKey),
				).pipe(executionErrors),
			)
			.handle("completeTestAuthorization", ({ params, payload }) =>
				Effect.flatMap(Identity, (value) =>
					testCommands.exchange(value, params.id, payload.commandKey),
				).pipe(executionErrors),
			)
			.handle("overview", () =>
				Effect.flatMap(owner, access.overview).pipe(executionErrors),
			)
			.handle("startClaim", ({ payload }) =>
				Effect.flatMap(owner, (value) => access.start(value, payload)).pipe(
					executionErrors,
				),
			)
			.handle("getClaim", ({ params }) =>
				Effect.flatMap(owner, (value) => access.claim(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("verifyClaim", ({ params, payload }) =>
				Effect.flatMap(Identity, (value) =>
					proofs.request(
						value,
						{ kind: "Claim", id: params.id },
						payload.commandKey,
					),
				).pipe(executionErrors),
			)
			.handle("revokeClaim", ({ params }) =>
				Effect.flatMap(owner, (value) => access.revoke(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("getProof", ({ params }) =>
				Effect.flatMap(owner, (value) =>
					access.ownProof(value, params.id),
				).pipe(
					Effect.map((proof) => proof.value),
					executionErrors,
				),
			)
			.handle("verifyProof", ({ params, payload }) =>
				Effect.flatMap(Identity, (value) =>
					proofs.request(
						value,
						{ kind: "Proof", id: params.id },
						payload.commandKey,
					),
				).pipe(executionErrors),
			)
			.handle("relinquish", ({ params }) =>
				Effect.flatMap(owner, (value) =>
					access.relinquish(value, params.id),
				).pipe(executionErrors),
			)
			.handle("members", ({ params }) =>
				Effect.flatMap(owner, (value) => members.list(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("invite", ({ params, payload }) =>
				Effect.flatMap(owner, (value) =>
					members.invite(value, params.id, payload.role),
				).pipe(executionErrors),
			)
			.handle("invitation", ({ params }) =>
				members.preview(params.id).pipe(executionErrors),
			)
			.handle("acceptInvitation", ({ params }) =>
				Effect.flatMap(Identity, (identity) =>
					members.accept(identity, params.id),
				).pipe(executionErrors),
			)
			.handle("revokeInvitation", ({ params }) =>
				Effect.flatMap(owner, (value) => members.revoke(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("changeMember", ({ params, payload }) =>
				Effect.flatMap(owner, (value) =>
					members.change(value, params.id, payload.role),
				).pipe(executionErrors),
			)
			.handle("removeMember", ({ params }) =>
				Effect.flatMap(owner, (value) => members.remove(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("saveInspection", ({ payload }) =>
				Effect.flatMap(owner, (value) =>
					reports.save(value, payload.cardUrl),
				).pipe(executionErrors),
			)
			.handle("reports", ({ query }) =>
				Effect.flatMap(owner, (value) =>
					reports.list(value, query.cardUrl, query.before),
				).pipe(executionErrors),
			)
			.handle("report", ({ params }) =>
				Effect.flatMap(owner, (value) => reports.get(value, params.id)).pipe(
					executionErrors,
				),
			)
			.handle("compare", ({ params, query }) =>
				Effect.flatMap(owner, (value) =>
					reports.compare(value, params.id, query.other),
				).pipe(executionErrors),
			)
			.handle("deleteReport", ({ params }) =>
				Effect.flatMap(owner, (value) => reports.remove(value, params.id)).pipe(
					executionErrors,
				),
			)
	}),
)
