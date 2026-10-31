import { Bot, type Chat, type ChatStore } from "@openbot-build/core"
import {
	ArtifactCommands,
	Artifacts as Data,
	Execution,
	executionCallers,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Option,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { Hex } from "effect/encoding"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Artifacts } from "../../artifacts/Artifacts.ts"
import { ArtifactFiles } from "../../artifacts/ArtifactFiles.ts"
import * as Citations from "../../artifacts/Citations.ts"
import { Work } from "../../capabilities/Work.ts"
import type * as ChatHost from "../../chats/ChatHost.ts"
import * as Db from "../../database/Database.ts"
import { Records } from "../../errors/Records.ts"
import { Store, type Fence } from "../../execution/Store.ts"
import * as ToolEntry from "../ToolEntry.ts"
import { toolJson } from "../ToolJson.ts"

export const names = {
	capture: "openbot_capture_source",
	list: "openbot_list_artifacts",
	read: "openbot_read_artifact",
	source: "openbot_read_source",
	publish: "openbot_publish_artifact",
	cite: "openbot_cite_sources",
} as const

const Capture = Schema.Struct({
	from: Data.SourceFrom,
	title: Schema.optionalKey(Schema.String),
	reportedUrl: Schema.optionalKey(Schema.String),
})
const Publish = Schema.Struct({
	title: ArtifactCommands.PublishArtifactRequest.fields.title,
	filename: ArtifactCommands.PublishArtifactRequest.fields.filename,
	mediaType: ArtifactCommands.PublishArtifactRequest.fields.mediaType,
	from: Data.ArtifactFrom,
	citations: Schema.Array(Data.SourceReference),
	artifactId: Schema.optionalKey(Data.ArtifactId),
	expectedVersion: Schema.optionalKey(Data.Version),
})
const Read = Schema.Struct({
	artifactId: Data.ArtifactId,
	version: Schema.optionalKey(Data.Version),
})
const ReadSource = Schema.Struct({ sourceId: Data.SourceId })
const Cite = Schema.Struct({ citations: Schema.Array(Data.SourceReference) })
const List = Schema.Struct({
	after: Schema.optionalKey(Data.ArtifactId),
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
})

interface Input {
	readonly read: (
		chat: Chat.Id,
	) => Effect.Effect<
		Chat.View<ChatHost.Values>,
		Chat.ChatNotFound | ChatStore.ChatStoreError
	>
}

/** Text work uses the same saved commands and files as HTTP callers. */
export class ArtifactTools extends Context.Service<
	ArtifactTools,
	{
		readonly register: (
			input: Input,
		) => Effect.Effect<Bot.ToolRegistration, never, Bot.Context | Work>
	}
>()("@openbot-build/openbot/plugins/artifacts/ArtifactTools") {}

export const durable = (fence: Fence) =>
	Effect.gen(function* () {
		const artifacts = yield* Artifacts
		const files = yield* ArtifactFiles
		const db = yield* Db.make
		const store = yield* Store
		const crypto = yield* Crypto.Crypto
		const records = yield* Records
		return ArtifactTools.of({
			register: (input) =>
				Effect.gen(function* () {
					const work = yield* Work
					const context = yield* Bot.Context
					const identity = { ...work.identity, parentExecutionId: fence.id }
					const callers = executionCallers(identity)
					const readAccess = Effect.forEach(
						callers,
						(caller) => artifacts.authorizeChat(caller, work.chat),
						{ discard: true },
					)
					const references = (refs: ReadonlyArray<Data.SourceReference>) =>
						Effect.forEach(
							callers,
							(caller) => artifacts.validateReferences(caller, work.chat, refs),
							{ discard: true },
						)
					const commandKey = (name: string, call: ToolEntry.CallContext) =>
						Effect.gen(function* () {
							const step = yield* context.step
							const bytes = new TextEncoder().encode(
								yield* Schema.encodeEffect(
									Schema.fromJsonString(Schema.Array(Schema.String)),
								)([
									fence.id,
									work.turn,
									String(step),
									name,
									call.toolCallId ?? name,
								]),
							)
							return Execution.CommandKey.make(
								"artifact-tool:" +
									Hex.encode(yield* crypto.digest("SHA-256", bytes)),
							)
						})
					const origin = Effect.gen(function* () {
						const view = yield* input.read(work.chat)
						const pending =
							view.chat.turn?.id === work.turn
								? view.chat.turn.pendingStep
								: undefined
						return {
							turnId: work.turn,
							...(pending === undefined ? {} : { itemId: pending.item }),
						}
					})
					const readText = (
						file: { readonly id: string; readonly mediaType: string },
						availability: Data.ArtifactVersion["availability"],
					) =>
						Effect.gen(function* () {
							if (availability !== "ready") return { text: null }
							if (
								!Str.startsWith("text/")(file.mediaType) &&
								file.mediaType !== "application/json"
							)
								return { text: null }
							const bytes = yield* files.read(file.id)
							if (Option.isNone(bytes)) return { text: null }
							return { text: new TextDecoder().decode(bytes.value) }
						})
					const entry = <A, I, E>(
						name: string,
						description: string,
						schema: Schema.Codec<A, I>,
						handle: (
							raw: A,
							call: ToolEntry.CallContext,
						) => Effect.Effect<Schema.Json, E>,
						read = false,
						plan = false,
					) => {
						const value = ToolEntry.entry(
							name,
							description,
							Schema.toJsonSchemaDocument(schema, {
								referencePolicy: () => undefined,
							}).schema,
							(raw, call) =>
								Effect.flatMap(
									Schema.decodeUnknownEffect(schema)(raw),
									(value) => handle(value, call),
								),
							{ records, executionId: fence.id },
						)
						return {
							...value,
							tool: value.tool
								.annotate(Tool.Readonly, read)
								.annotate(ToolEntry.PlanAllowed, plan)
								.annotate(ToolEntry.Idempotent, !read)
								.annotate(ToolEntry.Local, true),
						}
					}
					const entries = [
						entry(
							names.capture,
							"Save a fixed source from a public URL, a successful App result in this Chat, or a Computer UTF-8 file. Save sources before citing them. A reported URL is an address from the material.",
							Capture,
							(request, call) =>
								Effect.gen(function* () {
									const receipt = yield* artifacts.captureFor(
										identity,
										work.chat,
										{
											...request,
											commandKey: yield* commandKey(names.capture, call),
											turnId: work.turn,
										},
										true,
										fence,
									)
									return yield* artifacts.waitResult(identity.actor, receipt)
								}),
							false,
							true,
						),
						entry(
							names.list,
							"List the saved files of this Chat with their stable IDs and current versions. Use this before changing the last file.",
							List,
							(request) =>
								readAccess.pipe(
									Effect.andThen(
										artifacts.list(identity.actor, work.chat, request),
									),
									Effect.map(toolJson),
								),
							true,
						),
						entry(
							names.read,
							"Read a saved file and its fixed version. Without version, read the current version. The text field gives UTF-8 text for text files such as Markdown and CSV.",
							Read,
							(request) =>
								Effect.gen(function* () {
									yield* readAccess
									const saved =
										request.version === undefined
											? (yield* artifacts.get(
													identity.actor,
													work.chat,
													request.artifactId,
												)).latest
											: yield* artifacts.version(
													identity.actor,
													work.chat,
													request.artifactId,
													request.version,
												)
									return toolJson({
										...saved,
										...(yield* readText(saved.file, saved.availability)),
									})
								}),
							true,
						),
						entry(
							names.source,
							"Read a fixed source and its saved text before choosing a quote. The source does not prove that its facts are true.",
							ReadSource,
							(request) =>
								Effect.gen(function* () {
									yield* readAccess
									const saved = yield* artifacts.source(
										identity.actor,
										work.chat,
										request.sourceId,
									)
									return toolJson({
										...saved,
										...(yield* readText(saved.file, saved.availability)),
									})
								}),
							true,
						),
						entry(
							names.publish,
							"Publish a real file from text or a Computer path. Supply citations for the sources used. To change a file, keep its artifactId and give its expectedVersion. A change makes a new fixed version. After success, tell the person which files are ready.",
							Publish,
							(request, call) =>
								Effect.gen(function* () {
									if (
										(request.artifactId === undefined) !==
										(request.expectedVersion === undefined)
									)
										return yield* Data.ArtifactInvalid.make({
											message: "Give artifactId and expectedVersion together.",
										})
									const receipt = yield* artifacts.publishFor(
										identity,
										work.chat,
										{
											...request,
											...(yield* origin),
											commandKey: yield* commandKey(names.publish, call),
										},
										request.artifactId,
										true,
										fence,
									)
									return yield* artifacts.waitResult(identity.actor, receipt)
								}),
						),
						entry(
							names.cite,
							"Cite saved sources in your next assistant message with body text in this Turn. This call does not cite a tool call or a later Turn. Quotes must be present in each saved source.",
							Cite,
							(request, call) =>
								Effect.gen(function* () {
									yield* Effect.forEach(
										callers,
										(caller) =>
											artifacts.authorizeChat(caller, work.chat, "write"),
										{ discard: true },
									)
									yield* references(request.citations)
									const key = yield* commandKey(names.cite, call)
									yield* store.commit(
										fence,
										{},
										Citations.remember(db, {
											namespace: work.namespace,
											chat: work.chat,
											turn: work.turn,
											callId: Execution.CallId.make(key),
											afterStep: yield* context.step,
											citations: request.citations,
										}),
									)
									return toolJson({
										citations: request.citations,
										nextMessage: true,
									})
								}),
							false,
							true,
						),
					]
					const toolkit = Toolkit.make(
						...Arr.map(entries, (entry) => entry.tool),
					)
					const handlers = yield* toolkit.toHandlers(
						Rec.fromEntries(
							Arr.map(entries, (entry) => [entry.tool.name, entry.handle]),
						),
					)
					return {
						tools: toolkit.tools,
						handlers,
						instructions: Prompt.make([
							{
								role: "system",
								content: `When work needs files, save the sources, then publish files with their source references. A file is delivered only after publish succeeds. To change the last file, list or read it and keep its artifactId with expectedVersion. Use ${names.cite} before the next body answer that uses sources. Published file versions stay fixed.`,
							},
						]),
					}
				}),
		})
	})
