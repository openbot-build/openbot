import * as HttpErrors from "../execution/HttpErrors.ts"
import { OpenBotApi } from "@openbot-build/api"

import { Identity } from "@openbot-build/domain"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Files } from "./Files.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "files", (handlers) =>
	Effect.gen(function* () {
		const files = yield* Files
		const errors = yield* HttpErrors.make
		return handlers
			.handle("uploadFile", ({ payload }) =>
				Effect.flatMap(Identity, (caller) => files.upload(caller, payload)),
			)
			.handle("createUpload", ({ payload }) =>
				Effect.flatMap(Identity, (caller) =>
					files.createUpload(caller, payload),
				),
			)
			.handle("completeUpload", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					files.complete(caller, params.fileId),
				),
			)
			.handle("listFiles", ({ query }) =>
				Effect.flatMap(Identity, (caller) => files.list(caller, query)),
			)
			.handle("getFile", ({ params }) =>
				Effect.flatMap(Identity, (caller) => files.get(caller, params.fileId)),
			)
			.handle("getFileContent", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					files.content(caller, params.fileId),
				),
			)
			.handle("deleteFile", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					files.remove(caller, params.fileId).pipe(errors),
				),
			)
	}),
)
