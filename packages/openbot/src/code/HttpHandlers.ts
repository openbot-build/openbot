import { OpenBotApi } from "@openbot-build/api"
import { Identity } from "@openbot-build/domain"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Queries from "./CodeQueries.ts"
import * as HttpErrors from "../execution/HttpErrors.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "codeRuns", (handlers) =>
	Effect.gen(function* () {
		const queries = yield* Queries.make
		const safe = yield* HttpErrors.make
		return handlers
			.handle("get", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					queries.read(caller, params.id),
				).pipe(safe),
			)
			.handle("list", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					queries.list(caller, params.chatId),
				).pipe(safe),
			)
	}),
)
