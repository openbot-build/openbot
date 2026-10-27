import { Model, Provider } from "@openbot-build/core"
import { BotAuth } from "./AuthApi.ts"
import { Config, Live, Turn } from "@openbot-build/core"
import { Authorize, Required, own } from "./Authorization.ts"
import { BotErrors, BotId } from "./BotsApi.ts"
import {
	ChatExecutionUnavailable,
	ChatOperationErrors,
	ChatView,
	chatParams,
} from "./ChatsApi.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

/**
 * Live mode: a person talks with a Bot in real time over one WebSocket.
 *
 * Text frames hold one JSON message each: `LiveClientMessage` from the client and
 * `LiveServerMessage` from OpenBot. Binary frames hold sound. The client sends sound in
 * the input format of `session.ready`, and OpenBot sends sound in its output format.
 *
 * This protocol is the same for every Live backend. `session.ready` tells the client what
 * the backend can do.
 */

export const AudioFormat = Live.AudioFormat
export type AudioFormat = Live.AudioFormat
export const Capabilities = Live.Capabilities
export type Capabilities = Live.Capabilities

/** The text form of an audio format, such as `pcm16@24000`. */
export const AudioFormatText = Live.AudioFormatFromString

/** The model of a live Chat comes from the Chat. The query only sets the sound. */
export const LiveQuery = Schema.Struct({
	voice: Schema.optionalKey(Schema.NonEmptyString),
	/** The sound format that the client sends. Without it, OpenBot picks the first one. */
	inputFormat: Schema.optionalKey(AudioFormatText),
	/** The sound format that the client wants. Without it, OpenBot picks the first one. */
	outputFormat: Schema.optionalKey(AudioFormatText),
	/** `client` means push-to-talk: the client sends `input.audio.commit`. */
	turnDetection: Schema.optionalKey(Schema.Literals(["server", "client"])),
	/**
	 * The organization of a browser session. A browser cannot send the
	 * `OpenBot-Organization` header with a WebSocket, so it sends the ID here.
	 */
	organization: Schema.optionalKey(Schema.NonEmptyString),
})
export type LiveQuery = typeof LiveQuery.Type

export const LiveClientMessage = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("input.text"),
		text: Schema.NonEmptyString,
	}),
	/** An image, such as a frame of video. `data` is Base64. */
	Schema.Struct({
		type: Schema.Literal("input.image"),
		mediaType: Schema.String.check(Schema.isStartingWith("image/")),
		data: Schema.NonEmptyString,
	}),
	/** The person stopped talking. Only with client turn detection. */
	Schema.Struct({ type: Schema.Literal("input.audio.commit") }),
	/** Forget the sound that is not committed. */
	Schema.Struct({ type: Schema.Literal("input.audio.clear") }),
	/** Stop the answer and the Turn that runs it. */
	Schema.Struct({ type: Schema.Literal("response.cancel") }),
	/** The person heard the answer `itemId` only up to `audioEndMs`. */
	Schema.Struct({
		type: Schema.Literal("output.truncate"),
		itemId: Schema.NonEmptyString,
		audioEndMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	}),
])
export type LiveClientMessage = typeof LiveClientMessage.Type

export const LiveErrorCode = Schema.Literals([
	"unsupported",
	"connect",
	"protocol",
	"closed",
	"provider",
	"invalid_message",
	"chat",
])
export type LiveErrorCode = typeof LiveErrorCode.Type

export const LiveServerMessage = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("session.ready"),
		provider: Provider.Id,
		model: Model.Id,
		capabilities: Capabilities,
		audio: Schema.Struct({ input: AudioFormat, output: AudioFormat }),
		turnDetection: Schema.Literals(["server", "client"]),
		voice: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({ type: Schema.Literal("input.speech.started") }),
	Schema.Struct({ type: Schema.Literal("input.speech.stopped") }),
	Schema.Struct({
		type: Schema.Literal("input.transcript"),
		itemId: Schema.String,
		text: Schema.String,
		final: Schema.Boolean,
	}),
	Schema.Struct({
		type: Schema.Literal("output.transcript.delta"),
		itemId: Schema.String,
		delta: Schema.String,
	}),
	/** The answer item has no more sound or text. */
	Schema.Struct({
		type: Schema.Literal("output.done"),
		itemId: Schema.String,
	}),
	/** The person talks again. Stop playing the answer now. */
	Schema.Struct({ type: Schema.Literal("output.stop") }),
	Schema.Struct({
		type: Schema.Literal("turn.started"),
		turnId: Turn.Id,
	}),
	Schema.Struct({
		type: Schema.Literal("turn.completed"),
		turnId: Turn.Id,
		status: Turn.StatusTag,
	}),
	Schema.Struct({
		type: Schema.Literal("error"),
		code: LiveErrorCode,
		message: Schema.String,
	}),
])
export type LiveServerMessage = typeof LiveServerMessage.Type

/** The Chat has no Live model, or the backend cannot use the formats that the client asked for. */
export class LiveUnavailable extends Schema.TaggedError<
	LiveUnavailable,
	{ readonly brand: unique symbol }
>()("LiveUnavailable", { message: Schema.String }) {}

export const CreateLiveChatRequest = Schema.Struct({
	/** A Live model. Without it, OpenBot uses the first Live model of the organization. */
	model: Schema.optionalKey(Config.Selection),
})
export type CreateLiveChatRequest = typeof CreateLiveChatRequest.Type

export class LiveApi extends HttpApiGroup.make("live")
	.add(
		HttpApiEndpoint.post("createLiveChat", "/v1/bots/:botId/live", {
			params: { botId: BotId },
			payload: CreateLiveChatRequest,
			success: ChatView.pipe(HttpApiSchema.status(201)),
			error: [
				...ChatOperationErrors,
				...BotErrors,
				LiveUnavailable.pipe(HttpApiSchema.status(409)),
			],
		})
			.annotate(Required, [own("run", "Chat"), own("write", "Chat")])
			.annotate(
				OpenApi.Description,
				"Makes a new live Chat of yours with this Bot. Then open its Live WebSocket. You need `bots.delegate` on the Bot and `models.use` on the Live model.",
			),
		HttpApiEndpoint.get("connectLive", "/v1/chats/:chatId/live", {
			params: chatParams,
			query: LiveQuery,
			success: HttpApiSchema.NoContent,
			error: [
				...ChatOperationErrors,
				ChatExecutionUnavailable.pipe(HttpApiSchema.status(503)),
				LiveUnavailable.pipe(HttpApiSchema.status(409)),
			],
		})
			.annotate(Required, [own("run", "Chat", "chatId")])
			.annotate(
				OpenApi.Description,
				"Opens the Live WebSocket of a live Chat. Each thing the person says starts a Turn, and the Bot answers with sound and text. Only the server of the open session starts the Turns of the Chat. A browser must connect from the public origin.",
			),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.middleware(Authorize)
	.middleware(BotAuth) {}
