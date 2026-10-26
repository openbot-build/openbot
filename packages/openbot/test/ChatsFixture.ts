import { NodeServices } from "@effect/platform-node"
import type { ChatView } from "@openbot-build/api"
import { type Chat, Config, Model, Provider } from "@openbot-build/core"
import { Effect, Layer, Redacted } from "effect"
import type { LanguageModel } from "effect/ai"
import * as Signals from "../src/bots/Signals.ts"
import * as ChatFeatures from "../src/chats/ChatFeatures.ts"
import type * as Chats from "../src/chats/Chats.ts"
import * as LiveSessions from "../src/chats/live/LiveSessions.ts"
import * as OpenWork from "../src/chats/OpenWork.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as StoredOperations from "../src/operations/StoredOperations.ts"
import { ChatNotSettled } from "./Messages.ts"
import * as PostgresTest from "./PostgresTest.ts"

const provider = Provider.Id.make("test")
const id = Model.Id.make("test-model")

/** The test model. Each new Chat of `models` gets it. */
export const selection = Config.Selection.make({ provider, model: id })

/**
 * The models of a Chat runtime in a test: one test model, which each new Chat
 * gets. `model` gives its answers. `window` is the size of its context window.
 */
export const models = (
	model: typeof LanguageModel.LanguageModel.Service,
	window?: number,
): Pick<Chats.Options, "modelCatalog" | "resolveModel" | "defaultModel"> => ({
	modelCatalog: Effect.succeed({
		providers: [{ id: provider, name: "Test" }],
		models: [
			Config.Model.make({
				provider,
				id,
				name: "Test model",
				reasoningEfforts: [],
				serviceTiers: [],
				...(window === undefined ? {} : { maxContextWindow: window }),
			}),
		],
	}),
	resolveModel: () => Effect.succeed(model),
	defaultModel: selection,
})

/**
 * What a Chat runtime needs in a test of the Chats alone, besides the
 * database and the tools of the host: no plugins and no files, the Live
 * sessions of the process, no open work, the Bot signals, and one listener
 * for background tool calls. Give it once for each test file, because the
 * listener holds a connection of the database.
 */
export const services = Layer.mergeAll(
	ChatFeatures.none,
	LiveSessions.layer,
	OpenWork.layerNone,
	Signals.layer,
	StoredOperations.layerChannel,
)

/** A throwaway PostgreSQL server, with the Node services and the services of the Chats. */
export const layerDatabase = services.pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (database) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)

/** Waits from a view until the Chat rests. It may wait `left` more times. */
const rest = (
	chats: typeof Chats.Chats.Service,
	id: Chat.Id,
	view: ChatView,
	left: number,
): Effect.Effect<ChatView, Chats.ServiceError | ChatNotSettled> =>
	view.activity !== "active" && view.status !== "Running" && view.inbox === 0
		? Effect.succeed(view)
		: left === 0
			? Effect.fail(ChatNotSettled.make({ chat: id }))
			: Effect.flatMap(
					chats.wait(id, view.chat.revision, 500, view.activity),
					(next) => rest(chats, id, next, left - 1),
				)

/**
 * Waits until no Turn runs in a Chat and no input waits in its inbox.
 * It fails with `ChatNotSettled` after about thirty seconds.
 */
export const settled = (chats: typeof Chats.Chats.Service, id: Chat.Id) =>
	Effect.flatMap(chats.get(id), (view) => rest(chats, id, view, 60))
