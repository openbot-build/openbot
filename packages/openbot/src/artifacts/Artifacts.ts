import { Chat, Item } from "@openbot-build/core"
import {
	ArtifactCommands,
	Artifacts as Data,
	Authorization,
	Caller,
	Execution,
	ExecutionIdentity,
	Files as FileData,
	executionCallers,
} from "@openbot-build/domain"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Hex } from "effect/encoding"
import * as Check from "../authorization/Check.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import * as Db from "../database/Database.ts"
import {
	artifacts,
	artifactCitations,
	artifactJobs,
	artifactSources,
	artifactVersions,
	chats,
	chatItems,
	chatTurns,
	files,
	fileRefs,
	executions,
} from "../database/Schema.ts"
import {
	Store,
	type Fence,
	type Key,
	transactionFailures,
} from "../execution/Store.ts"
import { Observation } from "../execution/Observation.ts"
import { Calls } from "../execution/Calls.ts"
import { Registry, type Authorize } from "../execution/Engine.ts"
import { Organization } from "../organization/Organization.ts"
import { ArtifactFiles } from "./ArtifactFiles.ts"
import { Materials, normalizeText } from "./Materials.ts"

export const workflowName = "openbot.artifact-publish"
export const Origin = Schema.Struct({
	turnId: Schema.optionalKey(Schema.String),
	itemId: Schema.optionalKey(Schema.String),
})
export type Origin = typeof Origin.Type
const Input = Schema.TaggedUnion({
	Publish: {
		chat: Chat.Id,
		artifactId: Data.ArtifactId,
		expectedVersion: Schema.Int,
		request: ArtifactCommands.PublishArtifactRequest,
	},
	Capture: {
		chat: Chat.Id,
		sourceId: Data.SourceId,
		request: ArtifactCommands.CaptureSourceRequest,
	},
	Citations: {
		chat: Chat.Id,
		request: ArtifactCommands.RecordCitationsRequest,
	},
})
const metadata = Schema.Struct({
	filename: Schema.String,
	mediaType: Schema.String,
	title: Schema.String,
	origin: Schema.optionalKey(Data.SourceOrigin),
	capturedAt: Schema.Finite,
})
const inputJson = Schema.toCodecJson(Input)
const stringJson = Schema.fromJsonString(Schema.Json)
const references = Schema.fromJsonString(Schema.Array(Data.SourceReference))
const known = Schema.Union([
	Data.ArtifactNotFound,
	Data.SourceNotFound,
	Data.ArtifactConflict,
	Data.ArtifactInvalid,
	Data.ArtifactStorageUnavailable,
	FileData.FileNotFound,
	FileData.FileInvalid,
	FileData.FileQuotaExceeded,
	FileData.FilesDisabled,
	FileData.FilesUnavailable,
	Execution.Forbidden,
	Execution.NotFound,
	Execution.Conflict,
	Execution.KeyConflict,
	Execution.StorageError,
])
export type Failure = typeof known.Type

interface Access {
	readonly namespace: string
	readonly ref: Chat.Ref
	readonly identity: ExecutionIdentity
}
interface ArtifactPage {
	readonly items: ReadonlyArray<Data.Artifact>
	readonly next: Data.ArtifactId | null
}
interface VersionPage {
	readonly items: ReadonlyArray<Data.ArtifactVersion>
	readonly next: number | null
}
interface SourcePage {
	readonly items: ReadonlyArray<Data.Source>
	readonly next: Data.SourceId | null
}
interface ArtifactDetail {
	readonly artifact: Data.Artifact
	readonly latest: Data.ArtifactVersion
}
interface ItemArtifacts extends Item.Record {
	readonly artifacts: ReadonlyArray<Data.ArtifactVersion>
}
type Publish =
	| ArtifactCommands.PublishArtifactRequest
	| ArtifactCommands.PublishVersionRequest
type References = ReadonlyArray<Data.SourceReference>
type ArtifactQuery = {
	readonly limit?: number
	readonly after?: Data.ArtifactId
}
type VersionQuery = { readonly limit?: number; readonly after?: number }
type SourceQuery = { readonly limit?: number; readonly after?: Data.SourceId }
export interface Service {
	readonly authorizeChat: (
		caller: Caller,
		chat: Chat.Id,
		action?: "read" | "write",
	) => Effect.Effect<Access, Failure>
	readonly validateReferencesFor: (
		namespace: string,
		chat: Chat.Id,
		refs: References,
	) => Effect.Effect<References, Failure>
	readonly validateReferences: (
		caller: Caller,
		chat: Chat.Id,
		refs: References,
	) => Effect.Effect<References, Failure>
	readonly authorize: Authorize
	readonly perform: (fence: Fence) => Effect.Effect<void, Failure>
	readonly publishFor: (
		identity: ExecutionIdentity,
		chat: Chat.Id,
		request: Publish,
		artifactId?: Data.ArtifactId,
		trusted?: boolean,
		parent?: Fence,
	) => Effect.Effect<Execution.Receipt, Failure>
	readonly captureFor: (
		identity: ExecutionIdentity,
		chat: Chat.Id,
		request: ArtifactCommands.CaptureSourceRequest,
		trusted?: boolean,
		parent?: Fence,
	) => Effect.Effect<Execution.Receipt, Failure>
	readonly publish: (
		caller: Caller,
		chat: Chat.Id,
		request: Publish,
		artifactId?: Data.ArtifactId,
	) => Effect.Effect<Execution.Receipt, Failure>
	readonly capture: (
		caller: Caller,
		chat: Chat.Id,
		request: ArtifactCommands.CaptureSourceRequest,
	) => Effect.Effect<Execution.Receipt, Failure>
	readonly recordCitations: (
		caller: Caller,
		chat: Chat.Id,
		request: ArtifactCommands.RecordCitationsRequest,
	) => Effect.Effect<Execution.Receipt, Failure>
	readonly list: (
		caller: Caller,
		chat: Chat.Id,
		query?: ArtifactQuery,
	) => Effect.Effect<ArtifactPage, Failure>
	readonly get: (
		caller: Caller,
		chat: Chat.Id,
		id: Data.ArtifactId,
	) => Effect.Effect<ArtifactDetail, Failure>
	readonly versions: (
		caller: Caller,
		chat: Chat.Id,
		id: Data.ArtifactId,
		query?: VersionQuery,
	) => Effect.Effect<VersionPage, Failure>
	readonly version: (
		caller: Caller,
		chat: Chat.Id,
		id: Data.ArtifactId,
		version: number,
	) => Effect.Effect<Data.ArtifactVersion, Failure>
	readonly content: (
		caller: Caller,
		chat: Chat.Id,
		id: Data.ArtifactId,
		version: number,
	) => Effect.Effect<
		{
			readonly file: FileData.FileObject
			readonly stream: Stream.Stream<Uint8Array, FileData.FilesUnavailable>
		},
		Failure
	>
	readonly sources: (
		caller: Caller,
		chat: Chat.Id,
		query?: SourceQuery,
	) => Effect.Effect<SourcePage, Failure>
	readonly source: (
		caller: Caller,
		chat: Chat.Id,
		id: Data.SourceId,
	) => Effect.Effect<Data.Source, Failure>
	readonly sourceContent: (
		caller: Caller,
		chat: Chat.Id,
		id: Data.SourceId,
	) => Effect.Effect<
		Stream.Stream<Uint8Array, FileData.FilesUnavailable>,
		Failure
	>
	readonly enrichItems: (
		caller: Caller,
		chat: Chat.Id,
		items: ReadonlyArray<Item.Record>,
	) => Effect.Effect<ReadonlyArray<ItemArtifacts>, Failure>
	readonly waitResult: (
		caller: Caller,
		receipt: Execution.Receipt,
	) => Effect.Effect<Schema.Json, Failure>
}

/** Public errors keep private causes in the log. */
export const boundary = <A, E, R>(
	work: Effect.Effect<A, E, R>,
): Effect.Effect<A, Failure, R> =>
	work.pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterruptsOnly(cause))
				return Effect.failCause(
					Cause.fromReasons(Arr.filter(cause.reasons, Cause.isInterruptReason)),
				)
			const first = cause.reasons[0]
			if (
				cause.reasons.length === 1 &&
				first?._tag === "Fail" &&
				Schema.is(known)(first.error)
			)
				return Effect.fail(first.error)
			return Effect.logError("Artifact work failed", cause).pipe(
				Effect.andThen(Effect.fail(Data.ArtifactStorageUnavailable.make({}))),
			)
		}),
	)

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const checks = yield* Check.make
	const store = yield* Store
	const storage = yield* ArtifactFiles
	const material = yield* Materials
	const crypto = yield* Crypto.Crypto
	const observation = yield* Observation
	const calls = yield* Calls
	const registry = yield* Registry
	const organization = yield* Organization
	const encode = <S extends Schema.Constraint>(schema: S) =>
		Schema.encodeEffect(Schema.fromJsonString(schema))
	const decode = <S extends Schema.Constraint>(schema: S) =>
		Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
	const digest = (bytes: Uint8Array) =>
		crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode))
	const authorizeChat = (
		caller: Caller,
		chat: Chat.Id,
		action: "read" | "write" = "read",
	) =>
		Effect.gen(function* () {
			const rows = yield* db
				.select({ namespace: chats.namespace, body: chats.body })
				.from(chats)
				.where(eq(chats.id, chat))
			for (const row of rows) {
				const ref = yield* decode(Chat.Ref)(row.body)
				const host = ChatHost.hostState(ref)
				if (host.chain.organizationId !== caller.organizationId) continue
				if (
					Option.isNone(
						yield* organization.activeMember(
							caller.organizationId,
							caller.userId,
						),
					)
				)
					return yield* Execution.Forbidden.make({})
				yield* checks
					.check(caller, {
						action,
						resource: Authorization.Chat.make({
							organizationId: host.chain.organizationId,
							ownerUserId: ChatHost.ownerOf(host.chain),
							id: chat,
						}),
					})
					.pipe(
						Effect.catchTags({
							Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
							Pending: () => Effect.fail(Execution.Forbidden.make({})),
							PolicyUnavailable: (cause) =>
								Effect.logError("Could not check Chat access", cause).pipe(
									Effect.andThen(
										Effect.fail(Execution.StorageError.make({ cause })),
									),
								),
						}),
					)
				return {
					namespace: row.namespace,
					ref,
					identity: { ...ChatHost.identityOf(ref), actor: caller },
				}
			}
			return yield* Execution.Forbidden.make({})
		}).pipe(boundary)
	const authorizeIdentity = (
		identity: ExecutionIdentity,
		chat: Chat.Id,
		action: "read" | "write",
	) =>
		Effect.gen(function* () {
			const access = yield* authorizeChat(identity.actor, chat, action)
			if (
				Option.isNone(
					yield* organization.activeMember(
						identity.owner.organizationId,
						identity.owner.userId,
					),
				)
			)
				return yield* Execution.Forbidden.make({})
			if (
				access.identity.owner.organizationId !==
					identity.owner.organizationId ||
				access.identity.owner.userId !== identity.owner.userId
			)
				return yield* Execution.Forbidden.make({})
			for (const caller of executionCallers(identity))
				yield* authorizeChat(caller, chat, action)
			return access
		})
	const sourceFor = (namespace: string, chat: Chat.Id, id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(artifactSources)
				.where(
					and(
						eq(artifactSources.namespace, namespace),
						eq(artifactSources.chat, chat),
						eq(artifactSources.id, id),
					),
				))[0]
			if (row === undefined) return yield* Data.SourceNotFound.make({ id })
			const source = yield* decode(Data.Source)(row.body)
			const file = yield* storage.get(row.file)
			return {
				...source,
				availability:
					Option.isSome(file) && file.value.status === "ready"
						? ("ready" as const)
						: ("unavailable" as const),
			}
		})
	const validateReferencesFor = (
		namespace: string,
		chat: Chat.Id,
		refs: readonly Data.SourceReference[],
	) =>
		Effect.gen(function* () {
			for (const ref of refs) {
				const source = yield* sourceFor(namespace, chat, ref.source_id)
				if (source.availability !== "ready")
					return yield* Data.ArtifactInvalid.make({
						message: "The source content is no longer available.",
					})
				if (ref.quote !== undefined) {
					const quote = normalizeText(ref.quote)
					const bytes = yield* storage.read(source.file.id)
					if (
						quote.length === 0 ||
						Option.isNone(bytes) ||
						!Str.includes(quote)(
							normalizeText(new TextDecoder().decode(bytes.value)),
						)
					)
						return yield* Data.ArtifactInvalid.make({
							message: "The quote is not in the saved source.",
						})
				}
			}
			return refs
		}).pipe(boundary)
	const validateOrigin = (namespace: string, chat: Chat.Id, input: Origin) =>
		Effect.gen(function* () {
			if (
				input.turnId !== undefined &&
				(yield* db
					.select({ id: chatTurns.id })
					.from(chatTurns)
					.where(
						and(
							eq(chatTurns.namespace, namespace),
							eq(chatTurns.chat, chat),
							eq(chatTurns.id, input.turnId),
						),
					)).length === 0
			)
				return yield* Data.ArtifactInvalid.make({
					message: "The Turn is not in this Chat.",
				})
			if (
				input.itemId !== undefined &&
				(yield* db
					.select({ id: chatItems.id })
					.from(chatItems)
					.where(
						and(
							eq(chatItems.namespace, namespace),
							eq(chatItems.chat, chat),
							eq(chatItems.id, input.itemId),
						),
					)).length === 0
			)
				return yield* Data.ArtifactInvalid.make({
					message: "The Item is not in this Chat.",
				})
		})
	const findArtifact = (namespace: string, chat: Chat.Id, id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(artifacts)
				.where(
					and(
						eq(artifacts.namespace, namespace),
						eq(artifacts.chat, chat),
						eq(artifacts.id, id),
					),
				))[0]
			if (row === undefined) return yield* Data.ArtifactNotFound.make({ id })
			return row
		})
	const artifactView = (row: typeof artifacts.$inferSelect): Data.Artifact => ({
		id: Data.ArtifactId.make(row.id),
		chatId: Chat.Id.make(row.chat),
		title: row.title,
		latestVersion: row.latestVersion,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})
	const versionFor = (
		namespace: string,
		chat: Chat.Id,
		id: string,
		version: number,
	) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(artifactVersions)
				.where(
					and(
						eq(artifactVersions.namespace, namespace),
						eq(artifactVersions.chat, chat),
						eq(artifactVersions.artifact, id),
						eq(artifactVersions.version, version),
					),
				))[0]
			if (row === undefined) return yield* Data.ArtifactNotFound.make({ id })
			const saved = yield* decode(Data.ArtifactVersion)(row.body)
			const file = yield* storage.get(row.file)
			return {
				...saved,
				availability:
					Option.isSome(file) && file.value.status === "ready"
						? ("ready" as const)
						: ("unavailable" as const),
			}
		})
	const job = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(key)
			if (saved.workflow !== workflowName)
				return yield* Execution.Forbidden.make({})
			const input = yield* Schema.decodeEffect(inputJson)(saved.input)
			const row = (yield* db
				.select()
				.from(artifactJobs)
				.where(eq(artifactJobs.executionId, key.id)))[0]
			if (
				row === undefined ||
				row.namespace !== key.namespace ||
				row.chat !== input.chat
			)
				return yield* Execution.NotFound.make({ id: key.id })
			return { saved, input, row }
		})
	const authorize: Authorize = (key, actor, action) =>
		Effect.gen(function* () {
			const current = yield* job(key)
			if (action === "advance" || action === "replay") {
				if (!Schema.toEquivalence(Caller)(actor, current.saved.identity.actor))
					return yield* Execution.Forbidden.make({})
				yield* authorizeIdentity(
					current.saved.identity,
					current.input.chat,
					"write",
				)
				const parent = yield* store.ownership(key)
				if (parent.ownerExecutionId !== undefined) {
					const parentKey = yield* store.locate(
						parent.ownerExecutionId,
						actor.organizationId,
					)
					const owner = yield* store.loadMember(parentKey)
					if (
						Execution.isTerminal(owner.record.status) ||
						owner.record.status === "cancelling"
					)
						return yield* Execution.Forbidden.make({})
					const feature = yield* registry.get(owner.workflow)
					if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
					yield* feature.value.authorize(
						parentKey,
						owner.identity.actor,
						"advance",
					)
				}
			} else
				yield* authorizeChat(
					actor,
					current.input.chat,
					action === "read" ? "read" : "write",
				)
		}).pipe(
			boundary,
			Effect.catchIf(
				(
					error,
				): error is Exclude<
					Failure,
					Execution.Forbidden | Execution.NotFound | Execution.StorageError
				> =>
					!Schema.is(Execution.Forbidden)(error) &&
					!Schema.is(Execution.NotFound)(error) &&
					!Schema.is(Execution.StorageError)(error),
				(error) =>
					Effect.logError(
						"Could not check artifact access",
						Cause.fail(error),
					).pipe(
						Effect.andThen(
							Effect.fail(
								Execution.StorageError.make({ cause: Cause.fail(error) }),
							),
						),
					),
			),
		)
	const submit = (
		identity: ExecutionIdentity,
		input: typeof Input.Type,
		trusted: boolean,
		parent?: Fence,
	) =>
		Effect.gen(function* () {
			const access = yield* authorizeIdentity(identity, input.chat, "write")
			const body = yield* Schema.decodeEffect(Schema.Json)({
				kind: input._tag,
				chat: input.chat,
				artifactId:
					input._tag === "Publish" && input.expectedVersion > 0
						? input.artifactId
						: null,
				request: input.request,
			})
			const previous = yield* store.receipt(
				access.namespace,
				input.request.commandKey,
				{ actor: identity.actor, body },
			)
			if (Option.isSome(previous)) return previous.value
			if (!trusted && input._tag !== "Citations")
				yield* validateOrigin(access.namespace, input.chat, input.request)
			if (input._tag === "Publish") {
				yield* validateReferencesFor(
					access.namespace,
					input.chat,
					input.request.citations,
				)
				if (
					input.expectedVersion > 0 &&
					(yield* findArtifact(access.namespace, input.chat, input.artifactId))
						.latestVersion !== input.expectedVersion
				)
					return yield* Data.ArtifactConflict.make({
						message: "The artifact version is out of date.",
					})
			}
			if (input._tag === "Citations")
				yield* validateReferencesFor(
					access.namespace,
					input.chat,
					input.request.citations,
				)
			const json = yield* Schema.encodeEffect(inputJson)(input)
			return yield* store.accept(
				access.namespace,
				input.request.commandKey,
				{ actor: identity.actor, body },
				(allocate) =>
					Effect.gen(function* () {
						const create = Effect.gen(function* () {
							if (input._tag === "Publish" && input.expectedVersion > 0) {
								const locked = (yield* db
									.select()
									.from(artifacts)
									.where(eq(artifacts.id, input.artifactId))
									.for("update"))[0]
								if (
									locked === undefined ||
									locked.latestVersion !== input.expectedVersion
								)
									return yield* Data.ArtifactConflict.make({
										message: "The artifact version is out of date.",
									})
								const active = yield* db
									.select({ id: artifactJobs.executionId })
									.from(artifactJobs)
									.innerJoin(
										executions,
										eq(artifactJobs.executionId, executions.id),
									)
									.where(
										and(
											eq(artifactJobs.resourceId, input.artifactId),
											inArray(executions.status, [
												"queued",
												"running",
												"waiting",
												"cancelling",
												"outcome_unknown",
											]),
										),
									)
								if (active.length > 0)
									return yield* Data.ArtifactConflict.make({
										message:
											"This artifact already has a publication in progress.",
									})
							}
							const key = yield* allocate({
								workflow: workflowName,
								identity,
								resource: { kind: "Chat", id: input.chat },
								context: { kind: "Chat", id: input.chat },
								...(identity.parentExecutionId === undefined
									? {}
									: { ownerExecutionId: identity.parentExecutionId }),
								input: json,
							})
							yield* db.insert(artifactJobs).values({
								executionId: key.id,
								namespace: access.namespace,
								chat: input.chat,
								file: "file_" + Hex.encode(yield* crypto.randomBytes(16)),
								resourceId:
									input._tag === "Publish"
										? input.artifactId
										: input._tag === "Capture"
											? input.sourceId
											: input.request.itemId,
							})
							return { executionId: key.id, start: true }
						})
						if (parent === undefined) return yield* create
						if (
							parent.namespace !== access.namespace ||
							identity.parentExecutionId !== parent.id
						)
							return yield* Execution.Forbidden.make({})
						yield* calls.authorize(parent, "advance")
						const owner = yield* store.loadMember(parent)
						const position = yield* Schema.decodeUnknownEffect(
							Schema.Struct({ chat: Chat.Id }),
						)(owner.input)
						if (
							position.chat !== input.chat ||
							owner.record.resource.kind !== "Turn" ||
							input._tag === "Citations" ||
							owner.record.resource.id !== input.request.turnId
						)
							return yield* Execution.Forbidden.make({})
						// The child, its start command, and its parent link share one transaction.
						return yield* store.commit(
							parent,
							{
								events: (child) => [
									{
										_tag: "ChildExecution",
										executionId: child.executionId,
										step: "artifact:" + input.request.commandKey,
									},
								],
							},
							create,
						)
					}),
			)
		}).pipe(boundary)
	const publishFor = (
		identity: ExecutionIdentity,
		chat: Chat.Id,
		request:
			| ArtifactCommands.PublishArtifactRequest
			| ArtifactCommands.PublishVersionRequest,
		artifactId?: Data.ArtifactId,
		trusted = true,
		parent?: Fence,
	) =>
		Effect.gen(function* () {
			return yield* submit(
				identity,
				{
					_tag: "Publish",
					chat,
					artifactId:
						artifactId ??
						Data.ArtifactId.make(
							"artifact_" + Hex.encode(yield* crypto.randomBytes(16)),
						),
					expectedVersion:
						"expectedVersion" in request ? request.expectedVersion : 0,
					request,
				},
				trusted,
				parent,
			)
		}).pipe(boundary)
	const captureFor = (
		identity: ExecutionIdentity,
		chat: Chat.Id,
		request: ArtifactCommands.CaptureSourceRequest,
		trusted = true,
		parent?: Fence,
	) =>
		Effect.gen(function* () {
			return yield* submit(
				identity,
				{
					_tag: "Capture",
					chat,
					sourceId: Data.SourceId.make(
						"source_" + Hex.encode(yield* crypto.randomBytes(16)),
					),
					request,
				},
				trusted,
				parent,
			)
		}).pipe(boundary)
	const withCaller = <A, E>(
		caller: Caller,
		chat: Chat.Id,
		run: (identity: ExecutionIdentity) => Effect.Effect<A, E>,
	) =>
		Effect.gen(function* () {
			const access = yield* authorizeChat(caller, chat, "write")
			return yield* run(access.identity)
		}).pipe(boundary)
	const readyFile = (row: typeof files.$inferSelect): FileData.FileObject => ({
		id: FileData.FileId.make(row.id),
		object: "file",
		filename: row.filename,
		mediaType: row.mediaType,
		bytes: row.bytes,
		status: "ready",
		createdAt: row.createdAt,
	})
	const perform = (fence: Fence) =>
		Effect.gen(function* () {
			yield* authorize(
				fence,
				(yield* store.loadMember(fence)).identity.actor,
				"replay",
			)
			let current = yield* job(fence)
			if (current.row.result !== null) return
			const input = current.input
			if (input._tag === "Citations") {
				yield* validateReferencesFor(
					fence.namespace,
					input.chat,
					input.request.citations,
				)
				const savedItem = (yield* db
					.select()
					.from(chatItems)
					.where(
						and(
							eq(chatItems.namespace, fence.namespace),
							eq(chatItems.chat, input.chat),
							eq(chatItems.id, input.request.itemId),
						),
					))[0]
				if (savedItem === undefined)
					return yield* Data.ArtifactInvalid.make({
						message: "The message is not in this Chat.",
					})
				const entry = yield* decode(Item.Entry)(savedItem.value)
				if (
					!Arr.some(
						entry.content.content,
						(message) => message.role === "assistant",
					)
				)
					return yield* Data.ArtifactInvalid.make({
						message: "Only an assistant message may have source references.",
					})
				yield* store.commit(
					fence,
					{
						status: "completed",
						events: [
							{
								_tag: "CitationRecorded",
								chatId: input.chat,
								itemId: input.request.itemId,
								citations: input.request.citations,
							},
						],
					},
					Effect.gen(function* () {
						yield* db
							.insert(artifactCitations)
							.values({
								namespace: fence.namespace,
								chat: input.chat,
								item: input.request.itemId,
								citations: yield* Schema.encodeEffect(references)(
									input.request.citations,
								),
							})
							.onConflictDoUpdate({
								target: [
									artifactCitations.namespace,
									artifactCitations.chat,
									artifactCitations.item,
								],
								set: {
									citations: yield* Schema.encodeEffect(references)(
										input.request.citations,
									),
								},
							})
						yield* db
							.update(artifactJobs)
							.set({
								result: yield* Schema.encodeEffect(references)(
									input.request.citations,
								),
							})
							.where(eq(artifactJobs.executionId, fence.id))
					}),
				)
				return
			}
			if (current.row.snapshot === null) {
				const source =
					input._tag === "Capture"
						? yield* material.readSource(
								current.saved.identity,
								input.chat,
								input.request.from,
							)
						: undefined
				const bytes =
					input._tag === "Publish"
						? yield* material.readArtifact(
								current.saved.identity,
								input.request.from,
							)
						: new TextEncoder().encode(source!.text)
				const info =
					input._tag === "Publish"
						? {
								filename: input.request.filename,
								mediaType: Str.toLowerCase(input.request.mediaType),
								title: input.request.title,
							}
						: {
								filename: input.sourceId + ".txt",
								mediaType: "text/plain",
								title: input.request.title ?? source!.title ?? input.sourceId,
								origin: source!.origin,
							}
				const sha256 = yield* digest(bytes)
				const capturedAt = yield* Clock.currentTimeMillis
				yield* store.commit(
					fence,
					{},
					Effect.gen(function* () {
						yield* storage.reserve({
							id: current.row.file,
							identity: current.saved.identity,
							namespace: fence.namespace,
							chat: input.chat,
							executionId: fence.id,
							filename: info.filename,
							mediaType: info.mediaType,
							bytes: bytes.length,
						})
						yield* db
							.update(artifactJobs)
							.set({
								snapshot: Buffer.from(bytes).toString("base64"),
								metadata: yield* encode(metadata)({ ...info, capturedAt }),
								sha256,
							})
							.where(eq(artifactJobs.executionId, fence.id))
					}),
				)
				current = yield* job(fence)
			}
			if (
				current.row.snapshot === null ||
				current.row.metadata === null ||
				current.row.sha256 === null
			)
				return yield* Effect.die("The artifact snapshot is missing.")
			const bytes = Buffer.from(current.row.snapshot, "base64")
			const info = yield* decode(metadata)(current.row.metadata)
			const file = yield* storage.get(current.row.file)
			if (Option.isNone(file) || file.value.status !== "pending")
				return yield* FileData.FileNotFound.make({ id: current.row.file })
			const existing = yield* storage.read(current.row.file)
			if (Option.isSome(existing)) {
				if ((yield* digest(existing.value)) !== current.row.sha256)
					return yield* Data.ArtifactInvalid.make({
						message: "The stored file does not match this publication.",
					})
			}
			const call = yield* store.writeAttempt(
				fence,
				"store-file",
				{ file: current.row.file, sha256: current.row.sha256 },
				"idempotent",
			)
			const outcome = yield* calls.invoke(
				fence,
				{
					...call,
					savedResult: () =>
						Effect.succeed(
							Option.isSome(existing) ? Option.some(null) : Option.none(),
						),
				},
				() =>
					Option.isSome(existing)
						? Effect.succeed(null)
						: storage
								.put(current.row.file, bytes, info.mediaType)
								.pipe(Effect.as(null)),
			)
			if (outcome._tag === "Unknown") return
			const stored = yield* storage.read(current.row.file)
			if (
				Option.isNone(stored) ||
				(yield* digest(stored.value)) !== current.row.sha256
			)
				return yield* Data.ArtifactStorageUnavailable.make({})
			yield* authorize(fence, current.saved.identity.actor, "replay")
			const now = yield* Clock.currentTimeMillis
			yield* store.commit(
				fence,
				{
					status: "completed",
					events:
						input._tag === "Publish"
							? [
									{
										_tag: "ArtifactPublished",
										chatId: input.chat,
										artifactId: input.artifactId,
										version: input.expectedVersion + 1,
									},
								]
							: [
									{
										_tag: "SourceCaptured",
										chatId: input.chat,
										sourceId: input.sourceId,
									},
								],
				},
				Effect.gen(function* () {
					// The artifact row serializes updates while the execution fence stops old owners.
					if (input._tag === "Publish") {
						yield* db
							.insert(artifacts)
							.values({
								id: input.artifactId,
								namespace: fence.namespace,
								chat: input.chat,
								title: input.request.title,
								latestVersion: 0,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoNothing()
						const latest = (yield* db
							.select()
							.from(artifacts)
							.where(eq(artifacts.id, input.artifactId))
							.for("update"))[0]
						if (
							latest === undefined ||
							latest.latestVersion !== input.expectedVersion ||
							latest.namespace !== fence.namespace ||
							latest.chat !== input.chat
						)
							return yield* Data.ArtifactConflict.make({
								message: "The artifact version is out of date.",
							})
						yield* validateReferencesFor(
							fence.namespace,
							input.chat,
							input.request.citations,
						)
						const version: Data.ArtifactVersion = {
							artifactId: input.artifactId,
							version: input.expectedVersion + 1,
							chatId: input.chat,
							turnId: input.request.turnId ?? null,
							itemId: input.request.itemId ?? null,
							file: readyFile(file.value),
							sha256: current.row.sha256!,
							citations: input.request.citations,
							availability: "ready",
							createdAt: now,
						}
						yield* db.insert(artifactVersions).values({
							artifact: input.artifactId,
							version: version.version,
							namespace: fence.namespace,
							chat: input.chat,
							turn: version.turnId,
							item: version.itemId,
							file: current.row.file,
							body: yield* encode(Data.ArtifactVersion)(version),
						})
						yield* db
							.update(artifacts)
							.set({
								title: input.request.title,
								latestVersion: version.version,
								updatedAt: now,
							})
							.where(eq(artifacts.id, input.artifactId))
						yield* db
							.update(artifactJobs)
							.set({
								result: yield* encode(Data.ArtifactVersion)(version),
								snapshot: null,
							})
							.where(eq(artifactJobs.executionId, fence.id))
					} else {
						if (info.origin === undefined)
							return yield* Effect.die("The source origin is missing.")
						const source: Data.Source = {
							id: input.sourceId,
							chatId: input.chat,
							turnId: input.request.turnId ?? null,
							title: info.title,
							...(input.request.reportedUrl === undefined
								? {}
								: { reportedUrl: input.request.reportedUrl }),
							origin: info.origin,
							file: readyFile(file.value),
							sha256: current.row.sha256!,
							availability: "ready",
							capturedAt: info.capturedAt,
						}
						yield* db.insert(artifactSources).values({
							id: input.sourceId,
							namespace: fence.namespace,
							chat: input.chat,
							file: current.row.file,
							body: yield* encode(Data.Source)(source),
						})
						yield* db
							.update(artifactJobs)
							.set({
								result: yield* encode(Data.Source)(source),
								snapshot: null,
							})
							.where(eq(artifactJobs.executionId, fence.id))
					}
					yield* db
						.update(files)
						.set({ status: "ready", updatedAt: now })
						.where(
							and(eq(files.id, current.row.file), eq(files.status, "pending")),
						)
					yield* db
						.insert(fileRefs)
						.values({
							file: current.row.file,
							namespace: fence.namespace,
							chat: input.chat,
						})
						.onConflictDoNothing()
				}),
			)
		}).pipe(transactionFailures, boundary)
	return {
		authorizeChat,
		validateReferencesFor,
		validateReferences: (
			caller: Caller,
			chat: Chat.Id,
			refs: readonly Data.SourceReference[],
		) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				return yield* validateReferencesFor(access.namespace, chat, refs)
			}).pipe(boundary),
		authorize,
		perform,
		publishFor,
		captureFor,
		publish: (
			caller: Caller,
			chat: Chat.Id,
			request:
				| ArtifactCommands.PublishArtifactRequest
				| ArtifactCommands.PublishVersionRequest,
			artifactId?: Data.ArtifactId,
		) =>
			withCaller(caller, chat, (identity) =>
				publishFor(identity, chat, request, artifactId, false),
			),
		capture: (
			caller: Caller,
			chat: Chat.Id,
			request: ArtifactCommands.CaptureSourceRequest,
		) =>
			withCaller(caller, chat, (identity) =>
				captureFor(identity, chat, request, false),
			),
		recordCitations: (
			caller: Caller,
			chat: Chat.Id,
			request: ArtifactCommands.RecordCitationsRequest,
		) =>
			withCaller(caller, chat, (identity) =>
				submit(identity, { _tag: "Citations", chat, request }, false),
			),
		list: (
			caller: Caller,
			chat: Chat.Id,
			query: { readonly limit?: number; readonly after?: Data.ArtifactId } = {},
		) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				const limit = query.limit ?? 50
				const rows = yield* db
					.select()
					.from(artifacts)
					.where(
						and(
							eq(artifacts.namespace, access.namespace),
							eq(artifacts.chat, chat),
							query.after === undefined
								? undefined
								: gt(artifacts.id, query.after),
						),
					)
					.orderBy(asc(artifacts.id))
					.limit(limit + 1)
				const page = rows.slice(0, limit)
				return {
					items: Arr.map(page, artifactView),
					next:
						rows.length > limit
							? Data.ArtifactId.make(page[page.length - 1]!.id)
							: null,
				}
			}).pipe(boundary),
		get: (caller: Caller, chat: Chat.Id, id: Data.ArtifactId) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				const found = yield* findArtifact(access.namespace, chat, id)
				return {
					artifact: artifactView(found),
					latest: yield* versionFor(
						access.namespace,
						chat,
						id,
						found.latestVersion,
					),
				}
			}).pipe(boundary),
		versions: (
			caller: Caller,
			chat: Chat.Id,
			id: Data.ArtifactId,
			query: { readonly limit?: number; readonly after?: number } = {},
		) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				yield* findArtifact(access.namespace, chat, id)
				const limit = query.limit ?? 50
				const rows = yield* db
					.select()
					.from(artifactVersions)
					.where(
						and(
							eq(artifactVersions.namespace, access.namespace),
							eq(artifactVersions.chat, chat),
							eq(artifactVersions.artifact, id),
							query.after === undefined
								? undefined
								: gt(artifactVersions.version, query.after),
						),
					)
					.orderBy(asc(artifactVersions.version))
					.limit(limit + 1)
				return {
					items: yield* Effect.forEach(rows.slice(0, limit), (row) =>
						versionFor(access.namespace, chat, id, row.version),
					),
					next: rows.length > limit ? rows[limit - 1]!.version : null,
				}
			}).pipe(boundary),
		version: (
			caller: Caller,
			chat: Chat.Id,
			id: Data.ArtifactId,
			version: number,
		) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				return yield* versionFor(access.namespace, chat, id, version)
			}).pipe(boundary),
		content: (
			caller: Caller,
			chat: Chat.Id,
			id: Data.ArtifactId,
			version: number,
		) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				const saved = yield* versionFor(access.namespace, chat, id, version)
				return {
					file: saved.file,
					stream: yield* storage.content(saved.file.id),
				}
			}).pipe(boundary),
		sources: (
			caller: Caller,
			chat: Chat.Id,
			query: { readonly limit?: number; readonly after?: Data.SourceId } = {},
		) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				const limit = query.limit ?? 50
				const rows = yield* db
					.select()
					.from(artifactSources)
					.where(
						and(
							eq(artifactSources.namespace, access.namespace),
							eq(artifactSources.chat, chat),
							query.after === undefined
								? undefined
								: gt(artifactSources.id, query.after),
						),
					)
					.orderBy(asc(artifactSources.id))
					.limit(limit + 1)
				return {
					items: yield* Effect.forEach(rows.slice(0, limit), (row) =>
						sourceFor(access.namespace, chat, row.id),
					),
					next:
						rows.length > limit
							? Data.SourceId.make(rows[limit - 1]!.id)
							: null,
				}
			}).pipe(boundary),
		source: (caller: Caller, chat: Chat.Id, id: Data.SourceId) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				return yield* sourceFor(access.namespace, chat, id)
			}).pipe(boundary),
		sourceContent: (caller: Caller, chat: Chat.Id, id: Data.SourceId) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				return yield* storage.content(
					(yield* sourceFor(access.namespace, chat, id)).file.id,
				)
			}).pipe(boundary),
		enrichItems: (
			caller: Caller,
			chat: Chat.Id,
			items: readonly Item.Record[],
		) =>
			Effect.gen(function* () {
				const access = yield* authorizeChat(caller, chat)
				const rows =
					items.length === 0
						? []
						: yield* db
								.select()
								.from(artifactVersions)
								.where(
									and(
										eq(artifactVersions.namespace, access.namespace),
										eq(artifactVersions.chat, chat),
										inArray(
											artifactVersions.item,
											Arr.map(items, (item) => item.id),
										),
									),
								)
				const versions = yield* Effect.forEach(rows, (row) =>
					versionFor(access.namespace, chat, row.artifact, row.version),
				)
				return Arr.map(items, (item) => ({
					...item,
					artifacts: Arr.filter(
						versions,
						(version) => version.itemId === item.id,
					),
				}))
			}).pipe(boundary),
		waitResult: (caller: Caller, receipt: Execution.Receipt) =>
			Effect.gen(function* () {
				const key = yield* store.locate(
					receipt.executionId,
					caller.organizationId,
				)
				yield* authorize(key, caller, "read")
				yield* observation.observe(key, -1).pipe(
					Stream.takeUntil(
						(event) =>
							event.body._tag === "State" &&
							Execution.isTerminal(event.body.status),
					),
					Stream.runDrain,
				)
				yield* authorize(key, caller, "read")
				const state = yield* job(key)
				if (state.row.result === null)
					return yield* Data.ArtifactInvalid.make({
						message: "The publication did not complete. Check its execution.",
					})
				if (state.input._tag === "Publish")
					return yield* Schema.encodeEffect(
						Schema.toCodecJson(Data.ArtifactVersion),
					)(
						yield* versionFor(
							key.namespace,
							state.input.chat,
							state.input.artifactId,
							state.input.expectedVersion + 1,
						),
					)
				if (state.input._tag === "Capture")
					return yield* Schema.encodeEffect(Schema.toCodecJson(Data.Source))(
						yield* sourceFor(
							key.namespace,
							state.input.chat,
							state.input.sourceId,
						),
					)
				return yield* Schema.decodeEffect(stringJson)(state.row.result)
			}).pipe(boundary),
	}
})

export class Artifacts extends Context.Service<Artifacts, Service>()(
	"@openbot-build/openbot/artifacts/Artifacts",
) {}
export const layer = Layer.effect(Artifacts, make)
