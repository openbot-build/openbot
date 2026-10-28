import type { Busy, Failed, Gone } from "../resources/Resource.ts"
import {
	type ChatModelInvalid,
	Execution,
	Bots as BotDomain,
} from "@openbot-build/domain"
import {
	type Bot,
	type Config,
	Chat,
	ChatStoreRepository,
	Item,
	Model,
	Provider,
	Store as CoreStore,
	Turn,
	TurnRunner,
} from "@openbot-build/core"
import { type BillingStorageError, Billing } from "../billing/Billing.ts"
import type { Paused } from "../execution/Admission.ts"
import {
	type Scope,
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { Definition } from "./ToolDefinitions.ts"
import { ReviewTools } from "../capabilities/ReviewTools.ts"
import * as Registration from "../plugins/Registration.ts"
import { LanguageModel, Prompt, Toolkit } from "effect/ai"
import * as Hex from "effect/encoding/Hex"
import { Bots } from "../bots/Bots.ts"
import * as ChatModels from "./ChatModels.ts"
import { Records } from "../errors/Records.ts"
import { CurrentAttribution } from "../billing/MeteredModel.ts"
import * as Db from "../database/Database.ts"
import { Calls } from "../execution/Calls.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"
import * as Todos from "../plugins/work/Todos.ts"
import { ExecutionFeatures } from "./ExecutionFeatures.ts"
import * as ChatHost from "./ChatHost.ts"
import { inExecution } from "./ChatEncoding.ts"
import * as Compaction from "./Compaction.ts"
import { HostTools } from "./HostTools.ts"
import { InputCommands } from "./InputCommands.ts"
import * as ModelSteps from "./ModelSteps.ts"
import { ToolControls } from "./ToolControls.ts"
import * as TurnPersistence from "./TurnPersistence.ts"
import { TurnAccess } from "./TurnAccess.ts"
import { TurnTools } from "./TurnTools.ts"

import { LiveConnections } from "./live/LiveConnections.ts"

const Reference = Schema.Struct({
	chat: Chat.Id,
	actionDefinition: Schema.optionalKey(Definition),
})

export interface Service {
	readonly run: (
		fence: Fence,
	) => Effect.Effect<
		undefined,
		| BotDomain.BotNotFound
		| BotDomain.BotStorageUnavailable
		| Busy
		| ChatModelInvalid
		| Failed
		| Gone
		| Bot.ExecutionError<
				{},
				| BillingStorageError
				| Execution.Conflict
				| Execution.KeyConflict
				| Config.ModelConfigurationError
				| Execution.OutcomeUnknown
				| Paused
				| Schema.SchemaError
				| Execution.Failure
				| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
		  >
		| Chat.RuntimeError,
		Scope.Scope
	>
}

export class TurnSession extends Context.Service<TurnSession, Service>()(
	"@openbot-build/openbot/chats/TurnSession",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const executions = yield* Store
	const calls = yield* Calls
	const inputs = yield* InputCommands
	const featureScopes = yield* ExecutionFeatures
	const reviews = yield* ReviewTools
	const host = yield* HostTools
	const tools = yield* TurnTools
	const controls = yield* ToolControls
	const models = yield* ModelRegistry

	const bots = yield* Bots
	const live = yield* LiveConnections
	const crypto = yield* Crypto.Crypto
	const modelServices = yield* Effect.context<
		Store | Calls | Billing | Crypto.Crypto | Records | TurnAccess
	>().pipe(
		Effect.map(
			Context.pick(Store, Calls, Billing, Crypto.Crypto, Records, TurnAccess),
		),
	)
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const run = Effect.fn("TurnSession.run")(function* (fence: Fence) {
		yield* calls.authorize(fence, "replay")
		const saved = yield* executions.loadMember(fence)
		if (
			saved.generation !== fence.generation ||
			saved.record.resource.kind !== "Turn"
		)
			return yield* Execution.Conflict.make({ id: fence.id })
		const { chat, actionDefinition } = yield* Schema.decodeUnknownEffect(
			Reference,
		)(saved.input)
		const turn = Turn.Id.make(saved.record.resource.id)
		const store = yield* ChatStoreRepository.make({
			definition,
			persistence: TurnPersistence.make(db, executions, calls, {
				fence,
				chat,
				turn,
			}),
		})
		let view = yield* store.read(chat)
		const record = view.chat.turn
		if (record?.id !== turn)
			return yield* Execution.Conflict.make({ id: fence.id })
		if (record.status._tag === "Completed") return
		if (Turn.isTerminal(record.status))
			return yield* Execution.Conflict.make({ id: fence.id })
		const isLive = ChatHost.hostState(view.chat).kind === "live"
		if (isLive) yield* live.wait(fence, chat, record.settings.model)
		yield* calls.ready(fence)
		const features = yield* featureScopes.open(fence, {
			identity: saved.identity,
			chat,
			turn,
		})
		const selected =
			record.activeAction === undefined
				? record.input
				: [record.activeAction.item]
		const item = Arr.head(selected)
		if (Option.isNone(item))
			return yield* Execution.Conflict.make({ id: fence.id })
		const history = yield* store.items(chat, { turn })
		const prompt = Arr.reduce(selected, Prompt.empty, (prompt, id) => {
			const entry = Arr.findFirst(history, (entry) => entry.id === id)
			return Option.isNone(entry)
				? prompt
				: Prompt.concat(prompt, entry.value.content)
		})
		if (
			Arr.some(selected, (id) => !Arr.some(history, (entry) => entry.id === id))
		)
			return yield* Execution.Conflict.make({ id: fence.id })
		const organizationId = saved.identity.owner.organizationId
		const catalog = yield* isLive
			? models.liveCatalog(organizationId)
			: models.catalog(saved.identity.actor.organizationId)
		let selection = record.settings.model
		if (selection === undefined) {
			const botId = ChatHost.hostState(view.chat).bot
			const bot = yield* bots.find(organizationId, botId)
			if (Option.isNone(bot))
				return yield* BotDomain.BotNotFound.make({ bot: botId })
			const selected = yield* ChatModels.select(
				{
					kind: ChatHost.hostState(view.chat).kind,
					bot: bot.value,
					...(Option.isSome(models.defaultModel)
						? { defaultModel: models.defaultModel.value }
						: {}),
				},
				catalog,
			)
			// Keep the chosen model in this Turn before any outside call. A later Bot edit
			// affects the next Turn, and does not change a saved step on recovery.
			const changed = yield* store.modifyEffect({
				chat,
				update: (current) => {
					const active = current.chat.turn
					if (active?.id !== turn || Turn.isTerminal(active.status))
						return Effect.fail(Execution.Conflict.make({ id: fence.id }))
					if (active.settings.model !== undefined)
						return Effect.succeed([
							active.settings.model,
							Option.none(),
						] as const)
					return Effect.succeed([
						selected,
						Option.some({
							chat: {
								turn: {
									...active,
									settings: { ...active.settings, model: selected },
								},
							},
						}),
					] as const)
				},
			})
			view = changed.view
			selection = changed.result
		}
		const resolve = (selected: typeof selection) =>
			isLive
				? live
						.model(fence, chat, selected)
						.pipe(
							Effect.flatMap((model) =>
								models.meterLive(organizationId, selected, model),
							),
						)
				: models.resolve(saved.identity.actor.organizationId, selected)
		const model = features.withFiles(yield* resolve(selection))
		const limits = yield* features.operationSettings(organizationId)
		const adapters = yield* ModelSteps.makeExecutors(
			fence,
			selection,
			isLive ? "never" : "read_only",
		).pipe(Effect.provideContext(modelServices))
		const registerTools = Effect.gen(function* () {
			const registered = yield* features.register(
				{
					owner: { kind: "member", ...saved.identity.owner },
					namespace: fence.namespace,
					store,
					controls: controls.register(fence),
					deliver: (input, source) =>
						Effect.gen(function* () {
							const text = yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Schema.String)),
							)([fence.id, input.chat, source])
							const key = Hex.encode(
								yield* crypto
									.digest("SHA-256", new TextEncoder().encode(text))
									.pipe(Effect.orDie),
							)
							return yield* inputs.submit(
								fence.namespace,
								Execution.CommandKey.make(`turn-input:${key}`),
								{
									...input,
									identity: { ...input.identity, parentExecutionId: fence.id },
								},
							)
						}),
				},
				yield* host.register,
				saved.identity,
			)
			let fixed = registered
			if (actionDefinition !== undefined) {
				const restored = featureScopes.restore(fence, actionDefinition)
				if (Option.isNone(restored))
					return yield* Execution.Conflict.make({ id: fence.id })
				const entry = restored.value
				const toolkit = Toolkit.make(entry.tool)
				fixed = Registration.merge([
					registered,
					{
						tools: toolkit.tools,
						handlers: yield* toolkit.toHandlers({
							[entry.tool.name]: entry.handle,
						}),
					},
				])
				fixed = Registration.select(fixed, {
					review: ChatHost.hostState(view.chat).kind === "review",
					plan: record.settings.mode === "plan",
				})
			}
			const tools =
				ChatHost.hostState(view.chat).kind === "review"
					? Registration.merge([fixed, yield* reviews.register(fence)])
					: fixed
			return Registration.merge([
				tools,
				{
					tools: {},
					handlers: Context.empty(),
					// Pause before the step saves its input, so a later decision can steer it.
					beforeStep: ({ kind, turn }) =>
						kind !== "model" || turn.pendingStep !== undefined
							? Effect.succeed(true)
							: calls
									.ready(fence, {
										retry: isLive ? "never" : "read_only",
										input: { purpose: "turn" },
									})
									.pipe(Effect.as(true), Effect.orDie),
				},
			])
		})
		const runner = yield* TurnRunner.make({
			store,
			...adapters,
			executeTool: tools.executor(fence, limits),
			bot: {
				registerTools,
				modelCatalog: Effect.succeed(
					Arr.map(catalog.models, Compaction.withSummary),
				),
				providers: Arr.map(
					catalog.providers,
					(provider) =>
						new Provider.Provider({
							id: provider.id,
							model: (selection) =>
								resolve(selection).pipe(
									Effect.map((model) =>
										Model.make({
											provider: selection.provider,
											model: selection.model,
											layer: Layer.succeed(
												LanguageModel.LanguageModel,
												features.withFiles(model),
											),
										}),
									),
								),
						}),
				),
				compaction: Compaction.service,
				approvals: features.approvals,
			},
		}).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
		yield* runner
			.run({ view, turn, item: Item.Id.make(item.value), prompt })
			.pipe(
				Stream.runDrain,
				Effect.provideService(
					CurrentAttribution,
					Effect.succeed({
						source: "turn",
						chatId: chat,
						turnId: turn,
						userId: saved.identity.actor.userId,
						...(saved.identity.botId === undefined
							? {}
							: { botId: saved.identity.botId }),
						...(saved.identity.actor.tokenId === undefined
							? {}
							: { tokenId: saved.identity.actor.tokenId }),
					}),
				),
			)
	}, inExecution)
	return TurnSession.of({ run })
})

/** One workflow phase owns the model, tools and store of a Turn. */

export const layer = Layer.effect(TurnSession, make)
