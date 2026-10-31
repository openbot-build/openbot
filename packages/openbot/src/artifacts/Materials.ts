import { type Chat } from "@openbot-build/core"
import {
	AppCalls,
	Artifacts,
	executionCallers,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { PublicNetwork } from "@openbot-build/protocol/Network"
import {
	Array as Arr,
	Context,
	Effect,
	HashSet,
	Layer,
	Schema,
	String as Str,
	pipe,
} from "effect"
import { Base64 } from "effect/encoding"
import { parse, defaultTreeAdapter, type DefaultTreeAdapterTypes } from "parse5"
import * as AppQueries from "../apps/AppQueries.ts"
import { Computers } from "../computers/Computers.ts"
import * as Failures from "../errors/Failures.ts"

/** A source keeps the text that was read, not a later view of its address. */
export interface Material {
	readonly text: string
	readonly origin: Artifacts.SourceOrigin
	readonly title?: string
}

export type Failure =
	Artifacts.ArtifactInvalid | Artifacts.ArtifactStorageUnavailable

export class Materials extends Context.Service<
	Materials,
	{
		readonly readSource: (
			identity: ExecutionIdentity,
			chat: Chat.Id,
			from: Artifacts.SourceFrom,
		) => Effect.Effect<Material, Failure>
		readonly readArtifact: (
			identity: ExecutionIdentity,
			from: Artifacts.ArtifactFrom,
		) => Effect.Effect<Uint8Array, Failure>
	}
>()("@openbot-build/openbot/artifacts/Materials") {}

/** Source text and quotes use the same space and line rules for matching. */
export const normalizeText = (text: string): string =>
	pipe(
		text,
		Str.replace(/\r\n?/g, "\n"),
		Str.replace(/[^\S\n]+/g, " "),
		Str.replace(/ *\n */g, "\n"),
		Str.replace(/\n{3,}/g, "\n\n"),
		Str.trim,
	)

const excluded = HashSet.make("head", "script", "style", "template")
const blocks = HashSet.make(
	"address",
	"article",
	"aside",
	"blockquote",
	"br",
	"div",
	"dl",
	"dt",
	"dd",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tr",
	"td",
	"th",
	"ul",
)

type Node = DefaultTreeAdapterTypes.Node
const children = (node: Node): ReadonlyArray<Node> =>
	"childNodes" in node ? node.childNodes : []

const htmlText = (node: Node): string => {
	if (defaultTreeAdapter.isTextNode(node)) return node.value
	if (
		defaultTreeAdapter.isElementNode(node) &&
		HashSet.has(excluded, node.tagName)
	)
		return ""
	if (defaultTreeAdapter.isElementNode(node) && node.tagName === "br")
		return "\n"
	const content = Arr.join(Arr.map(children(node), htmlText), "")
	return defaultTreeAdapter.isElementNode(node) &&
		HashSet.has(blocks, node.tagName)
		? `\n${content}\n`
		: content
}

const titleOf = (node: Node): string | undefined => {
	if (defaultTreeAdapter.isElementNode(node) && node.tagName === "title")
		return (
			normalizeText(Arr.join(Arr.map(children(node), htmlText), "")) ||
			undefined
		)
	for (const child of children(node)) {
		const title = titleOf(child)
		if (title !== undefined) return title
	}
	return undefined
}

/** Basic HTML text only. This does not run scripts or find an article body. */
export const documentText = (
	text: string,
	mediaType: string,
): { readonly text: string; readonly title?: string } => {
	if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml")
		return { text: normalizeText(text) }
	const document = parse(text)
	const title = titleOf(document)
	return {
		text: normalizeText(htmlText(document)),
		...(title === undefined ? {} : { title }),
	}
}

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const encoder = new TextEncoder()

export const make = Effect.gen(function* () {
	const network = yield* PublicNetwork
	const apps = yield* AppQueries.make
	const computers = yield* Computers

	const readComputer = (
		identity: ExecutionIdentity,
		id: string,
		path: string,
	) =>
		Effect.gen(function* () {
			const { machine } = yield* computers.machine(identity, id)
			const file = yield* machine.shell.read(path, "base64")
			return file.encoding === "base64"
				? yield* Effect.fromResult(Base64.decode(file.content))
				: encoder.encode(file.content)
		}).pipe(
			Failures.replace("Could not read the Computer file", () =>
				Artifacts.ArtifactStorageUnavailable.make({}),
			),
		)

	return Materials.of({
		readArtifact: (identity, from) =>
			from._tag === "Text"
				? Effect.succeed(encoder.encode(from.text))
				: readComputer(identity, from.computerId, from.path),
		readSource: (identity, chat, from) =>
			Effect.gen(function* () {
				switch (from._tag) {
					case "PublicUrl": {
						const reply = yield* network
							.readDocument({ url: from.url })
							.pipe(
								Failures.replace("Could not read the source URL", () =>
									Artifacts.ArtifactStorageUnavailable.make({}),
								),
							)
						if (reply.status < 200 || reply.status >= 300)
							return yield* Artifacts.ArtifactInvalid.make({
								message: "The source URL did not give a document.",
							})
						const mediaType = pipe(
							reply.headers["content-type"] ?? "text/plain",
							Str.split(";"),
							Arr.headNonEmpty,
							Str.trim,
							Str.toLowerCase,
						)
						if (
							!Str.startsWith("text/")(mediaType) &&
							mediaType !== "application/json" &&
							mediaType !== "application/xhtml+xml"
						)
							return yield* Artifacts.ArtifactInvalid.make({
								message: "The source URL must give text, HTML, or JSON.",
							})
						return {
							...documentText(reply.text, mediaType),
							origin: { ...from, finalUrl: reply.url },
						}
					}
					case "AppResult": {
						const id = AppCalls.AppOperationId.make(from.operationId)
						const saved = yield* apps
							.history(identity.actor, id)
							.pipe(
								Failures.replace("Could not read the saved App result", () =>
									Artifacts.ArtifactStorageUnavailable.make({}),
								),
							)
						for (const caller of executionCallers(identity))
							yield* apps
								.history(caller, id)
								.pipe(
									Failures.replace("Could not read the saved App result", () =>
										Artifacts.ArtifactStorageUnavailable.make({}),
									),
								)
						const operation = saved.operation
						if (
							operation.chat !== chat ||
							operation.status !== "completed" ||
							operation.result?._tag !== "Completed"
						)
							return yield* Artifacts.ArtifactInvalid.make({
								message: "Use a completed App result from this Chat.",
							})
						const text = yield* jsonText(operation.result.result).pipe(
							Failures.replace("Could not read the App result as text", () =>
								Artifacts.ArtifactStorageUnavailable.make({}),
							),
						)
						return {
							text,
							origin: from,
							title: operation.toolName,
						}
					}
					case "ComputerTextFile": {
						const bytes = yield* readComputer(
							identity,
							from.computerId,
							from.path,
						)
						const text = yield* Effect.try(() =>
							new TextDecoder("utf-8", { fatal: true }).decode(bytes),
						).pipe(
							Failures.replace("Could not read the source as UTF-8 text", () =>
								Artifacts.ArtifactInvalid.make({
									message: "The source file must be UTF-8 text.",
								}),
							),
						)
						return { text, origin: from }
					}
				}
			}).pipe(
				Effect.filterOrFail(
					(material) => normalizeText(material.text).length > 0,
					() =>
						Artifacts.ArtifactInvalid.make({
							message: "The source has no text to keep.",
						}),
				),
			),
	})
})

export const layer = Layer.effect(Materials, make)
