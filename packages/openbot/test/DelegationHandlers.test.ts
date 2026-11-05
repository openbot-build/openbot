import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
	AuthApi,
	Authorize,
	DelegationsApi,
	FailureApi,
} from "@openbot-build/api"
import { Execution, Identity } from "@openbot-build/domain"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import {
	Delegations,
	type Stored,
} from "../src/conversation-contract/bots/Delegations.ts"
import { DelegationCommands } from "../src/plugin-bots/DelegationCommands.ts"
import * as DelegationHandlers from "../src/plugin-bots/DelegationHandlers.ts"
import { Commands } from "@openbot-build/server-execution/execution/Commands"
import {
	Store,
	type Loaded,
} from "@openbot-build/server-execution/execution/Store"
import { Unavailable } from "@openbot-build/server-execution/execution/Workflows"
import { ImportedRecords } from "@openbot-build/server-execution/imported/ImportedRecords"
import * as Boundary from "@openbot-build/server-kernel/errors/HttpBoundary"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import * as Reporting from "@openbot-build/server-kernel/errors/Reporting"

const api = HttpApi.make("openbot-api")
	.add(DelegationsApi.DelegationsApi)
	.middleware(FailureApi.FailureBoundary)
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const executionId = Execution.Id.make("delegation-execution")

it.effect(
	"cancel answers 503 FeatureUnavailable when the feature of the delegation is not loaded",
	() =>
		Effect.gen(function* () {
			const saved = yield* Ref.make(0)
			const records = Layer.succeed(Records, {
				record: (_, category) =>
					Ref.update(saved, (n) => n + 1).pipe(
						Effect.as({
							errorId: Execution.ErrorId.make("delegation-error"),
							category,
						}),
					),
			})
			// The handler reads only these fields of the saved records.
			const found = {
				executionId,
				userId: "user",
				chain: { userId: "user" },
			} as unknown as Stored
			const loaded = { workflow: "openbot.delegation" } as unknown as Loaded
			const services = Layer.mergeAll(
				records,
				Layer.mock(Delegations, {
					find: () => Effect.succeedSome(found),
				}),
				Layer.mock(DelegationCommands, { authorize: () => Effect.void }),
				Layer.mock(Commands, {
					cancel: () =>
						Effect.fail(
							Unavailable.make({
								workflow: "openbot.delegation",
								feature: "bots",
							}),
						),
				}),
				Layer.mock(Store, {
					locate: (id) => Effect.succeed({ namespace: "org", id }),
					load: () => Effect.succeed(loaded),
				}),
				Layer.mock(ImportedRecords, {}),
				Layer.succeed(AuthApi.BotAuth, {
					token: (effect) => Effect.provideService(effect, Identity, actor),
					session: (effect) => Effect.provideService(effect, Identity, actor),
				}),
				Layer.succeed(Authorize, (effect) => effect),
			)
			const routes = Layer.merge(
				HttpApiBuilder.layer(api).pipe(
					Layer.provide(DelegationHandlers.layerPlatform),
					Layer.provide(Boundary.layer),
				),
				Reporting.layerHttp,
			)
			const server = HttpRouter.serve(routes, {
				disableLogger: true,
				disableListenLog: true,
			}).pipe(
				Layer.provide(services),
				Layer.provideMerge(NodeHttpServer.layerTest),
				Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
			)
			yield* Effect.gen(function* () {
				const response = yield* HttpClient.execute(
					HttpClientRequest.post("/v1/delegations/work/cancel").pipe(
						HttpClientRequest.bearerToken("token"),
						HttpClientRequest.bodyJsonUnsafe({ commandKey: "cancel" }),
					),
				)
				assert.strictEqual(response.status, 503)
				assert.strictEqual(response.headers["retry-after"], "5")
				assert.strictEqual(response.headers[FailureApi.featureHeader], "bots")
				assert.deepStrictEqual(yield* response.json, {
					_tag: "FeatureUnavailable",
					feature: "bots",
				})
				// Nothing failed, so the server keeps no error record.
				assert.strictEqual(yield* Ref.get(saved), 0)
			}).pipe(Effect.provide(server))
		}),
)
