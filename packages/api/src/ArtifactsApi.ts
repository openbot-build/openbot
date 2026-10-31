import { Chat } from "@openbot-build/core"
import { ArtifactCommands, Artifacts, Execution } from "@openbot-build/domain"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import { Authorize, GroupRequired, own } from "./Authorization.ts"
import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { FileErrors } from "./FilesApi.ts"
import { ChatOperationErrors } from "./ChatsApi.ts"
import { Limit } from "./Page.ts"

export {
	Artifact,
	ArtifactId,
	ArtifactVersion,
	ArtifactFrom,
	Source,
	SourceId,
	SourceFrom,
	SourceOrigin,
	SourceReference,
	ChatItem,
	Version,
	Digest,
	Availability,
	ArtifactNotFound,
	SourceNotFound,
	ArtifactConflict,
	ArtifactInvalid,
	ArtifactStorageUnavailable,
} from "@openbot-build/domain/Artifacts"

export {
	PublishArtifactRequest,
	PublishVersionRequest,
	CaptureSourceRequest,
	RecordCitationsRequest,
} from "@openbot-build/domain/ArtifactCommands"
const {
	PublishArtifactRequest,
	PublishVersionRequest,
	CaptureSourceRequest,
	RecordCitationsRequest,
} = ArtifactCommands

export const ArtifactPage = Schema.Struct({
	items: Schema.Array(Artifacts.Artifact),
	next: Schema.NullOr(Artifacts.ArtifactId),
})
export type ArtifactPage = typeof ArtifactPage.Type
export const VersionPage = Schema.Struct({
	items: Schema.Array(Artifacts.ArtifactVersion),
	next: Schema.NullOr(Artifacts.Version),
})
export type VersionPage = typeof VersionPage.Type
export const SourcePage = Schema.Struct({
	items: Schema.Array(Artifacts.Source),
	next: Schema.NullOr(Artifacts.SourceId),
})
export type SourcePage = typeof SourcePage.Type
export const ArtifactDetail = Schema.Struct({
	artifact: Artifacts.Artifact,
	latest: Artifacts.ArtifactVersion,
})
export type ArtifactDetail = typeof ArtifactDetail.Type

export const ArtifactErrors = [
	...ChatOperationErrors,
	Artifacts.ArtifactNotFound.pipe(HttpApiSchema.status(404)),
	Artifacts.SourceNotFound.pipe(HttpApiSchema.status(404)),
	Artifacts.ArtifactConflict.pipe(HttpApiSchema.status(409)),
	Artifacts.ArtifactInvalid.pipe(HttpApiSchema.status(400)),
	Artifacts.ArtifactStorageUnavailable.pipe(HttpApiSchema.status(503)),
	...FileErrors,
	...ExecutionErrors,
] as const

const chat = { chatId: Chat.Id }
const artifact = { ...chat, artifactId: Artifacts.ArtifactId }
const version = {
	...artifact,
	version: Schema.FiniteFromString.pipe(Schema.decodeTo(Artifacts.Version)),
}
const source = { ...chat, sourceId: Artifacts.SourceId }
const receipt = Execution.Receipt.pipe(HttpApiSchema.status(202))
const content = HttpApiSchema.StreamUint8Array({
	contentType: "application/octet-stream",
})

export class ArtifactsApi extends HttpApiGroup.make("artifacts")
	.add(
		HttpApiEndpoint.post("publishArtifact", "/v1/chats/:chatId/artifacts", {
			params: chat,
			payload: PublishArtifactRequest,
			success: receipt,
			error: ArtifactErrors,
		}).annotate(
			OpenApi.Description,
			"Publishes a new file with a stable artifact ID.",
		),
		HttpApiEndpoint.post(
			"publishVersion",
			"/v1/chats/:chatId/artifacts/:artifactId/versions",
			{
				params: artifact,
				payload: PublishVersionRequest,
				success: receipt,
				error: ArtifactErrors,
			},
		).annotate(
			OpenApi.Description,
			"Publishes a fixed new version. The expected version must still be current.",
		),
		HttpApiEndpoint.get("listArtifacts", "/v1/chats/:chatId/artifacts", {
			params: chat,
			query: {
				limit: Schema.optionalKey(Limit(100)),
				after: Schema.optionalKey(Artifacts.ArtifactId),
			},
			success: ArtifactPage,
			error: ArtifactErrors,
		}),
		HttpApiEndpoint.get(
			"getArtifact",
			"/v1/chats/:chatId/artifacts/:artifactId",
			{
				params: artifact,
				success: ArtifactDetail,
				error: ArtifactErrors,
			},
		),
		HttpApiEndpoint.get(
			"listVersions",
			"/v1/chats/:chatId/artifacts/:artifactId/versions",
			{
				params: artifact,
				query: {
					limit: Schema.optionalKey(Limit(100)),
					after: Schema.optionalKey(
						Schema.FiniteFromString.pipe(Schema.decodeTo(Artifacts.Version)),
					),
				},
				success: VersionPage,
				error: ArtifactErrors,
			},
		),
		HttpApiEndpoint.get(
			"getVersion",
			"/v1/chats/:chatId/artifacts/:artifactId/versions/:version",
			{
				params: version,
				success: Artifacts.ArtifactVersion,
				error: ArtifactErrors,
			},
		),
		HttpApiEndpoint.get(
			"getArtifactContent",
			"/v1/chats/:chatId/artifacts/:artifactId/versions/:version/content",
			{
				params: version,
				success: content,
				error: ArtifactErrors,
			},
		).annotate(
			OpenApi.Description,
			"Downloads a fixed file version. Content-Type and Content-Length give its saved type and size. Content-Disposition gives its saved file name with a UTF-8 name and an ASCII fallback.",
		),
		HttpApiEndpoint.post("captureSource", "/v1/chats/:chatId/sources", {
			params: chat,
			payload: CaptureSourceRequest,
			success: receipt,
			error: ArtifactErrors,
		}),
		HttpApiEndpoint.get("listSources", "/v1/chats/:chatId/sources", {
			params: chat,
			query: {
				limit: Schema.optionalKey(Limit(100)),
				after: Schema.optionalKey(Artifacts.SourceId),
			},
			success: SourcePage,
			error: ArtifactErrors,
		}),
		HttpApiEndpoint.get("getSource", "/v1/chats/:chatId/sources/:sourceId", {
			params: source,
			success: Artifacts.Source,
			error: ArtifactErrors,
		}),
		HttpApiEndpoint.get(
			"getSourceContent",
			"/v1/chats/:chatId/sources/:sourceId/content",
			{
				params: source,
				success: content,
				error: ArtifactErrors,
			},
		),
		HttpApiEndpoint.post("recordCitations", "/v1/chats/:chatId/citations", {
			params: chat,
			payload: RecordCitationsRequest,
			success: receipt,
			error: ArtifactErrors,
		}),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [own("read", "Chat", "chatId")],
		write: [own("write", "Chat", "chatId")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
