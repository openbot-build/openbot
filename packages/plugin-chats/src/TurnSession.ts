import type {
	Busy,
	Failed,
	Gone,
} from "@openbot-build/server-execution/resources/Resource"
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
import {
	type BillingStorageError,
	Billing,
} from "@openbot-build/server-billing/billing/Billing"
import type { Paused } from "@openbot-build/server-execution/execution/Admission"
import {
	type Scope,
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { Digest } from "effect/crypto"
import { Definition } from "@openbot-build/tools-contract/chats/ToolDefinitions"
import { ReviewTools } from "@openbot-build/conversation-contract/capabilities/ReviewTools"
import * as Registration from "@openbot-build/tools-contract/plugins/Registration"
import { LanguageModel, Prompt, Toolkit } from "effect/ai"
import * as Hex from "effect/encoding/Hex"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import * as ChatModels from "@openbot-build/conversation-contract/chats/ChatModels"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { CurrentAttribution } from "@openbot-build/server-billing/billing/MeteredModel"
import * as Db from "@openbot-build/server-database/Database"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import {
	Store,
	type Fence,
} from "@openbot-build/server-execution/execution/Store"
import { ModelRegistry } from "@openbot-build/models-contract/models/ModelRegistry"
import * as Todos from "@openbot-build/tools-contract/plugins/work/Todos"
import { ExecutionFeatures } from "./ExecutionFeatures.ts"
import type * as BotFeatures from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as ChatHost from "@openbot-build/conversation-contract/chats/ChatHost"
import { inExecution } from "@openbot-build/conversation-contract/chats/ChatEncoding"
import * as Compaction from "./Compaction.ts"
import { HostTools } from "@openbot-build/tools-contract/chats/HostTools"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import * as ModelSteps from "./ModelSteps.ts"
import { ToolControls } from "./ToolControls.ts"
import * as TurnPersistence from "./TurnPersistence.ts"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { TurnTools } from "./TurnTools.ts"

import { LiveConnections } from "./live/LiveConnections.ts"

const Reference = Schema.Struct({
	chat: Chat.Id,
	actionDefinition: Schema.optionalKey(Definition),
})

export interface Service {
	/** Runs one phase of a Turn with the features that the Turn pinned. */
	readonly run: (
		fence: Fence,
		pins: ReadonlyArray<BotFeatures.Pin>,
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
				| BotFeatures.FeatureStopped
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
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
	"@openbot-build/openbot/plugin-chats/TurnSession",
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
	const crypto = yield* Digest.Digest
	const modelServices = yield* Effect.context<
		Store | Calls | Billing | Digest.Digest | Records | TurnAccess
	>().pipe(
		Effect.map(
			Context.pick(Store, Calls, Billing, Digest.Digest, Records, TurnAccess),
		),
	)
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore, ...Todos.stores },
		schemaVersion: "chat/1",
	})
	const run = Effect.fn("TurnSession.run")(function* (
		fence: Fence,
		pins: ReadonlyArray<BotFeatures.Pin>,
	) {
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
		// The phase scope holds the pinned features until the phase ends.
		const features = yield* featureScopes.open(
			fence,
			{ identity: saved.identity, chat, turn },
			pins,
		)
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
									.digest(Digest.sha256, new TextEncoder().encode(text))
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
				const restored = features.restore(actionDefinition)
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
		// The types are written out because the hooks of a feature and the
		// providers fail with different errors, and inference takes only one.
		const bot: Bot.Definition<
			{},
			BotFeatures.FeatureStopped | Config.ModelConfigurationError,
			never,
			| Execution.Conflict
			| Execution.Forbidden
			| Execution.NotFound
			| Execution.StorageError
		> = {
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
		}
		const runner = yield* TurnRunner.make({
			store,
			...adapters,
			executeTool: tools.executor(fence, limits),
			bot,
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
