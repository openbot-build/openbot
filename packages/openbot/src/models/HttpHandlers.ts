import {
	type Caller,
	Identity,
	ModelProvidersApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey } from "../authorization/Policy.ts"
import { Settings } from "../settings/Settings.ts"
import {
	ModelProviders,
	organizationOwner,
	type Owner,
	view,
} from "./ModelProviders.ts"
import { ModelRegistry } from "./ModelRegistry.ts"
import { Models, view as modelView } from "./Models.ts"

const unavailable = () => ModelProvidersApi.ModelProvidersUnavailable.make({})

/**
 * A provider cannot go while a setting still names it, or the default model
 * of new Sessions would point at nothing.
 */
export const checkUnused = (input: {
	readonly providerId: string
	readonly organizationIds: ReadonlyArray<string>
}) =>
	Effect.gen(function* () {
		const settings = yield* Settings
		for (const organizationId of input.organizationIds) {
			const current = yield* settings
				.organization(organizationId)
				.pipe(Effect.mapError(unavailable))
			if (
				current.document.defaultModel?.provider === input.providerId ||
				current.document.helperModel?.provider === input.providerId ||
				current.document.decisionModel?.provider === input.providerId
			)
				return yield* ModelProvidersApi.ModelProviderInUse.make({
					providerId: input.providerId,
				})
		}
	})

export const layer = HttpApiBuilder.group(
	OpenBotApi,
	"modelProviders",
	(handlers) =>
		Effect.gen(function* () {
			const providers = yield* ModelProviders
			const models = yield* Models
			const registry = yield* ModelRegistry
			const audit = yield* AuditLog
			const settings = yield* Settings
			const record = (
				caller: Caller,
				action:
					| "model_provider.created"
					| "model_provider.updated"
					| "model_provider.deleted",
				details: { readonly providerId: string; readonly name: string },
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource:
							organizationKey(caller.organizationId) +
							".model." +
							details.providerId,
						details,
					})
					.pipe(Effect.mapError(unavailable))
			const recordModel = (
				caller: Caller,
				action: "model.created" | "model.updated" | "model.deleted",
				details: { readonly modelId: string; readonly name: string },
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource:
							organizationKey(caller.organizationId) +
							".model." +
							details.modelId,
						details,
					})
					.pipe(Effect.mapError(unavailable))
			const owned = (caller: Caller): Owner =>
				organizationOwner(caller.organizationId)
			const find = (caller: Caller, providerId: string) =>
				providers.get(owned(caller), providerId).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () =>
								Effect.fail(
									ModelProvidersApi.ModelProviderNotFound.make({ providerId }),
								),
							onSome: Effect.succeed,
						}),
					),
				)
			const findModel = (caller: Caller, modelId: string) =>
				models.get(owned(caller), modelId).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () =>
								Effect.fail(ModelProvidersApi.ModelNotFound.make({ modelId })),
							onSome: Effect.succeed,
						}),
					),
				)
			return handlers
				.handle("getModelCatalog", () =>
					Effect.flatMap(Identity, (caller) =>
						registry.view(caller.organizationId),
					).pipe(Effect.mapError(unavailable)),
				)
				.handle("listModels", () =>
					Effect.flatMap(Identity, (caller) => models.list(owned(caller))).pipe(
						Effect.map((items) => ({ items: items.map(modelView) })),
					),
				)
				.handle("getModel", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						findModel(caller, params.modelId),
					).pipe(Effect.map(modelView)),
				)
				.handle("createModel", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const created = yield* models.create(owned(caller), {
							...payload,
							// Only the platform shares models.
							availability: { _tag: "None" },
						})
						yield* recordModel(caller, "model.created", {
							modelId: created.id,
							name: created.name,
						})
						return modelView(created)
					}),
				)
				.handle("updateModel", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const updated = yield* models.update(
							owned(caller),
							params.modelId,
							payload,
						)
						yield* recordModel(caller, "model.updated", {
							modelId: updated.id,
							name: updated.name,
						})
						return modelView(updated)
					}),
				)
				.handle("deleteModel", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const model = yield* findModel(caller, params.modelId)
						yield* models.delete(owned(caller), model.id)
						yield* recordModel(caller, "model.deleted", {
							modelId: model.id,
							name: model.name,
						})
					}),
				)
				.handle("listModelProviders", () =>
					Effect.flatMap(Identity, (caller) =>
						providers.list(owned(caller)),
					).pipe(Effect.map((items) => ({ items: items.map(view) }))),
				)
				.handle("getModelProvider", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						find(caller, params.providerId),
					).pipe(Effect.map(view)),
				)
				.handle("createModelProvider", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const created = yield* providers.create(owned(caller), {
							...payload,
							// Only the platform shares providers.
							availability: { _tag: "None" },
						})
						yield* record(caller, "model_provider.created", {
							providerId: created.id,
							name: created.name,
						})
						return view(created)
					}),
				)
				.handle("updateModelProvider", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const updated = yield* providers.update(
							owned(caller),
							params.providerId,
							payload,
						)
						yield* record(caller, "model_provider.updated", {
							providerId: updated.id,
							name: updated.name,
						})
						return view(updated)
					}),
				)
				.handle("deleteModelProvider", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const provider = yield* find(caller, params.providerId)
						yield* checkUnused({
							providerId: provider.id,
							organizationIds: [caller.organizationId],
						}).pipe(Effect.provideService(Settings, settings))
						yield* providers.delete(owned(caller), provider.id)
						yield* record(caller, "model_provider.deleted", {
							providerId: provider.id,
							name: provider.name,
						})
					}),
				)
		}),
)
