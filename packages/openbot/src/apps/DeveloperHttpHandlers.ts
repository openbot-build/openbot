import {
	AuthApi,
	DeveloperApi as Api,
	Identity,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect, Layer, Option, Redacted } from "effect"
import * as HttpMiddleware from "../auth/HttpMiddleware.ts"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AppInspections } from "./AppInspections.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { DeveloperMembers } from "./DeveloperMembers.ts"
import { DeveloperReports } from "./DeveloperReports.ts"
import { ownerKey, ownersOf } from "./Repository.ts"
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
			return handlers
				.handleRaw("authorizationCallback", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const owner = yield* Option.match(
							Option.fromNullishOr(request.cookies[AuthApi.SessionCookie]),
							{
								onNone: () => Effect.succeedNone,
								onSome: (cookie) =>
									auth.resolveSession(Redacted.make(cookie)).pipe(
										Effect.tap(({ setCookies }) =>
											HttpMiddleware.setSessionCookies(setCookies),
										),
										Effect.map((value) => Option.some(ownersOf(value))),
										// A rejected session is the same as no session: the caller must log in.
										Effect.catchTag(
											"CredentialRejected",
											() => Effect.succeedNone,
										),
										Effect.mapError(() => Api.DeveloperUnavailable.make({})),
									),
							},
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
					}),
				)
				.handle("inspect", ({ payload }) => inspections.inspect(payload.input))
		}),
).pipe(Layer.provide(HttpMiddleware.layerNoStore))

export const layer = HttpApiBuilder.group(OpenBotApi, "developer", (handlers) =>
	Effect.gen(function* () {
		const access = yield* DeveloperAccess
		const members = yield* DeveloperMembers
		const reports = yield* DeveloperReports
		const tests = yield* DeveloperTests
		const owner = Effect.map(Identity, ownerKey)
		const indexing = yield* DeveloperIndexing
		const notifications = yield* DeveloperNotifications
		return handlers
			.handle("personalReports", ({ query }) =>
				Effect.flatMap(owner, (value) => reports.personal(value, query.before)),
			)
			.handle("notifications", ({ query }) =>
				Effect.flatMap(owner, (value) =>
					notifications.list(value, query.before),
				),
			)
			.handle("readNotification", ({ params }) =>
				Effect.flatMap(owner, (value) => notifications.read(value, params.id)),
			)
			.handle("subscriptions", () =>
				Effect.flatMap(owner, notifications.subscriptions),
			)
			.handle("subscribe", ({ payload }) =>
				Effect.flatMap(owner, (value) =>
					notifications.subscribe(value, payload),
				),
			)
			.handle("requestIndexing", ({ payload }) =>
				Effect.flatMap(owner, (value) =>
					indexing.request(value, payload.cardUrl),
				),
			)
			.handle("indexingRequests", ({ query }) =>
				Effect.flatMap(owner, (value) => indexing.list(value, query.cardUrl)),
			)
			.handle("indexingRequest", ({ params }) =>
				Effect.flatMap(owner, (value) => indexing.get(value, params.id)),
			)
			.handle("createTest", ({ payload }) =>
				Effect.flatMap(owner, (value) => tests.create(value, payload)),
			)
			.handle("tests", () => Effect.flatMap(owner, tests.list))
			.handle("test", ({ params }) =>
				Effect.flatMap(owner, (value) => tests.get(value, params.id)),
			)
			.handle("configureTest", ({ params, payload }) =>
				Effect.flatMap(owner, (value) =>
					tests.configure(value, params.id, payload),
				),
			)
			.handle("runTest", ({ params }) =>
				Effect.flatMap(owner, (value) => tests.run(value, params.id)),
			)
			.handle("cancelTest", ({ params }) =>
				Effect.flatMap(owner, (value) => tests.cancel(value, params.id)),
			)
			.handle("cleanupTest", ({ params }) =>
				Effect.flatMap(owner, (value) => tests.cleanup(value, params.id)),
			)
			.handle("deleteTest", ({ params }) =>
				Effect.flatMap(owner, (value) => tests.remove(value, params.id)),
			)
			.handle("authorizeTest", ({ params, payload }) =>
				Effect.flatMap(owner, (value) =>
					tests.authorize(value, params.id, payload),
				),
			)
			.handle("completeTestAuthorization", ({ params }) =>
				Effect.flatMap(owner, (value) => tests.complete(value, params.id)),
			)
			.handle("overview", () => Effect.flatMap(owner, access.overview))
			.handle("startClaim", ({ payload }) =>
				Effect.flatMap(owner, (value) => access.start(value, payload)),
			)
			.handle("getClaim", ({ params }) =>
				Effect.flatMap(owner, (value) => access.claim(value, params.id)),
			)
			.handle("verifyClaim", ({ params }) =>
				Effect.flatMap(owner, (value) => access.verify(value, params.id)),
			)
			.handle("revokeClaim", ({ params }) =>
				Effect.flatMap(owner, (value) => access.revoke(value, params.id)),
			)
			.handle("verifyProof", ({ params }) =>
				Effect.gen(function* () {
					yield* access.ownProof(yield* owner, params.id)
					return yield* access.recheck(params.id)
				}),
			)
			.handle("relinquish", ({ params }) =>
				Effect.flatMap(owner, (value) => access.relinquish(value, params.id)),
			)
			.handle("members", ({ params }) =>
				Effect.flatMap(owner, (value) => members.list(value, params.id)),
			)
			.handle("invite", ({ params, payload }) =>
				Effect.flatMap(owner, (value) =>
					members.invite(value, params.id, payload.role),
				),
			)
			.handle("invitation", ({ params }) => members.preview(params.id))
			.handle("acceptInvitation", ({ params }) =>
				Effect.flatMap(Identity, (identity) =>
					members.accept(identity, params.id),
				),
			)
			.handle("revokeInvitation", ({ params }) =>
				Effect.flatMap(owner, (value) => members.revoke(value, params.id)),
			)
			.handle("changeMember", ({ params, payload }) =>
				Effect.flatMap(owner, (value) =>
					members.change(value, params.id, payload.role),
				),
			)
			.handle("removeMember", ({ params }) =>
				Effect.flatMap(owner, (value) => members.remove(value, params.id)),
			)
			.handle("saveInspection", ({ payload }) =>
				Effect.flatMap(owner, (value) => reports.save(value, payload.cardUrl)),
			)
			.handle("reports", ({ query }) =>
				Effect.flatMap(owner, (value) =>
					reports.list(value, query.cardUrl, query.before),
				),
			)
			.handle("report", ({ params }) =>
				Effect.flatMap(owner, (value) => reports.get(value, params.id)),
			)
			.handle("compare", ({ params, query }) =>
				Effect.flatMap(owner, (value) =>
					reports.compare(value, params.id, query.other),
				),
			)
			.handle("deleteReport", ({ params }) =>
				Effect.flatMap(owner, (value) => reports.remove(value, params.id)),
			)
	}),
)
