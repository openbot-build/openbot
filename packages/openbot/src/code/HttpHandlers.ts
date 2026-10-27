import { Identity, OpenBotApi } from "@openbot-build/api"
import { Array as Arr, Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { ownerKey } from "../apps/StoredConnections.ts"
import { CodeRuns } from "./CodeRuns.ts"
import { view } from "./StoredCodeRuns.ts"

/** Each caller reads only the programs of their own Chats. */
export const layer = HttpApiBuilder.group(OpenBotApi, "codeRuns", (handlers) =>
	Effect.gen(function* () {
		const runs = yield* CodeRuns
		const owner = Effect.map(Identity, ownerKey)
		return handlers
			.handle("get", ({ params }) =>
				Effect.flatMap(owner, (owner) =>
					runs.get(owner, params.id).pipe(Effect.map(view)),
				),
			)
			.handle("list", ({ params }) =>
				Effect.flatMap(owner, (owner) =>
					runs
						.list(owner, params.chatId)
						.pipe(Effect.map((list) => Arr.map(list, view))),
				),
			)
	}),
)
