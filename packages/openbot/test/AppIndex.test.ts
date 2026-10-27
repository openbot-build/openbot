import { assert, it } from "@effect/vitest"
import { OpenBotApi } from "@openbot-build/api"
import { Effect } from "effect"
import { OpenApi } from "effect/http-api"

it.effect(
	"public Index contract declares anonymous reads and typed page failures",
	() =>
		Effect.sync(() => {
			const document = OpenApi.fromApi(OpenBotApi)
			const operation = document.paths["/v1/app-index/apps"]?.get
			assert.ok(operation)
			assert.ok(
				operation.security === undefined || operation.security.length === 0,
			)
			assert.ok(operation.responses["400"])
			assert.ok(operation.responses["503"])
			assert.ok(document.paths["/v1/apps/discover"]?.post?.security?.length)
		}),
)
