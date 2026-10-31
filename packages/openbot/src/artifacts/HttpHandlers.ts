import { OpenBotApi } from "@openbot-build/api"
import { Identity } from "@openbot-build/domain"
import { Effect, pipe, String as Str } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpErrors from "../execution/HttpErrors.ts"
import { Artifacts } from "./Artifacts.ts"

/** Keep the saved name in UTF-8 and use plain ASCII for older clients. */
const disposition = (filename: string) => {
	const fallback = Str.replace(/[^A-Za-z0-9._-]/g, "_")(filename)
	const encoded = pipe(
		encodeURIComponent(filename.toWellFormed()),
		Str.replaceAll("!", "%21"),
		Str.replaceAll("'", "%27"),
		Str.replaceAll("(", "%28"),
		Str.replaceAll(")", "%29"),
		Str.replaceAll("*", "%2A"),
	)
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export const layer = HttpApiBuilder.group(OpenBotApi, "artifacts", (handlers) =>
	Effect.gen(function* () {
		const work = yield* Artifacts
		const errors = yield* HttpErrors.make
		return handlers
			.handle("publishArtifact", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					work.publish(caller, params.chatId, payload).pipe(errors),
				),
			)
			.handle("publishVersion", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					work
						.publish(caller, params.chatId, payload, params.artifactId)
						.pipe(errors),
				),
			)
			.handle("listArtifacts", ({ params, query }) =>
				Effect.flatMap(Identity, (caller) =>
					work.list(caller, params.chatId, query).pipe(errors),
				),
			)
			.handle("getArtifact", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					work.get(caller, params.chatId, params.artifactId).pipe(errors),
				),
			)
			.handle("listVersions", ({ params, query }) =>
				Effect.flatMap(Identity, (caller) =>
					work
						.versions(caller, params.chatId, params.artifactId, query)
						.pipe(errors),
				),
			)
			.handle("getVersion", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					work
						.version(caller, params.chatId, params.artifactId, params.version)
						.pipe(errors),
				),
			)
			.handleRaw<"getArtifactContent", Identity>(
				"getArtifactContent",
				({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						work
							.content(caller, params.chatId, params.artifactId, params.version)
							.pipe(
								errors,
								Effect.map(({ file, stream }) =>
									HttpServerResponse.stream(stream, {
										contentType: file.mediaType,
										contentLength: file.bytes,
										headers: {
											"content-disposition": disposition(file.filename),
										},
									}),
								),
							),
					),
			)
			.handle("captureSource", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					work.capture(caller, params.chatId, payload).pipe(errors),
				),
			)
			.handle("listSources", ({ params, query }) =>
				Effect.flatMap(Identity, (caller) =>
					work.sources(caller, params.chatId, query).pipe(errors),
				),
			)
			.handle("getSource", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					work.source(caller, params.chatId, params.sourceId).pipe(errors),
				),
			)
			.handle<"getSourceContent", Identity>("getSourceContent", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					work
						.sourceContent(caller, params.chatId, params.sourceId)
						.pipe(errors),
				),
			)
			.handle("recordCitations", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					work.recordCitations(caller, params.chatId, payload).pipe(errors),
				),
			)
	}),
)
