import {
	Account,
	type AccountCaller,
	ModelProvidersApi,
	OpenBotApi,
	PlatformApi,
	Settings as SettingsApi,
} from "@openbot-build/api"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import { Billing } from "../billing/Billing.ts"
import { organizationKey, platformKey } from "../audit/Resources.ts"
import { checkUnused } from "../models/HttpHandlers.ts"
import {
	ModelProviders,
	platformOwner,
	view,
} from "../models/ModelProviders.ts"
import { Models, view as modelView } from "../models/Models.ts"
import { Organization } from "../organization/Organization.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import { filesOf, type PlatformDocument } from "../settings/Documents.ts"
import { bindings, changeFiles } from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import * as Views from "../settings/Views.ts"
import { PlatformAdmins } from "./PlatformAdmins.ts"

/** Platform actions go to this audit log, apart from the logs of organizations. */
export const platformLog = "platform"

const group = HttpApiBuilder.group(OpenBotApi, "platform", (handlers) =>
	Effect.gen(function* () {
		const settings = yield* Settings
		const secrets = yield* Secrets
		const admins = yield* PlatformAdmins
		const organization = yield* Organization
		const providers = yield* ModelProviders
		const models = yield* Models
		const audit = yield* AuditLog
		const billing = yield* Billing
		const credits = <A>(
			effect: Effect.Effect<
				A,
				{ readonly _tag: "BillingStorageError" | "OrganizationMissing" }
			>,
			organizationId: string,
		) =>
			effect.pipe(
				Effect.mapError((error) =>
					error._tag === "OrganizationMissing"
						? PlatformApi.OrganizationNotFound.make({ organizationId })
						: PlatformApi.PlatformUnavailable.make({}),
				),
			)
		const record = (
			account: AccountCaller,
			input: {
				readonly organizationId?: string
				readonly action: Parameters<typeof audit.record>[0]["action"]
				readonly resource: string
				readonly details: Parameters<typeof audit.record>[0]["details"]
			},
		) =>
			audit
				.record({
					organizationId: input.organizationId ?? platformLog,
					action: input.action,
					actor: {
						kind: account.kind,
						userId: account.userId,
						organizationId: input.organizationId ?? platformLog,
						...(account.tokenId === undefined
							? {}
							: { tokenId: account.tokenId }),
					},
					resource: input.resource,
					details: input.details,
				})
				.pipe(Effect.mapError(() => PlatformApi.PlatformUnavailable.make({})))
		const current = settings.platform.pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(SettingsApi.SettingsUnavailable.make({})),
					onSome: Effect.succeed,
				}),
			),
		)
		const findProvider = (providerId: string) =>
			providers.get(platformOwner, providerId).pipe(
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
		const findModel = (modelId: string) =>
			models.get(platformOwner, modelId).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(ModelProvidersApi.ModelNotFound.make({ modelId })),
						onSome: Effect.succeed,
					}),
				),
			)
		/** Every organization, page by page. */
		const allOrganizations = Effect.gen(function* () {
			const ids: Array<string> = []
			let after: string | undefined
			do {
				const page = yield* organization.list({
					limit: 100,
					...(after === undefined ? {} : { after }),
				})
				ids.push(...page.items.map((item) => item.id))
				after = page.next ?? undefined
			} while (after !== undefined)
			return ids
		})

		return handlers
			.handle("getPlatformSettings", () => Effect.map(current, Views.platform))
			.handle("updatePlatformSettings", ({ payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const {
						expectedVersion,
						identityProvider,
						files: filesInput,
						...changes
					} = payload
					const updated = yield* settings.updatePlatform(
						expectedVersion,
						(document) =>
							Effect.gen(function* () {
								const provider: PlatformDocument["identityProvider"] =
									identityProvider === undefined
										? document.identityProvider
										: identityProvider === null
											? null
											: {
													issuer: identityProvider.issuer,
													clientId: identityProvider.clientId,
													...(identityProvider.clientSecret === undefined
														? {
																clientSecret:
																	document.identityProvider?.clientSecret ??
																	null,
																clientSecretHint:
																	document.identityProvider?.clientSecretHint ??
																	null,
															}
														: identityProvider.clientSecret === null
															? { clientSecret: null, clientSecretHint: null }
															: {
																	clientSecret: yield* secrets.seal(
																		identityProvider.clientSecret,
																		bindings.identityProviderSecret,
																	),
																	clientSecretHint: hint(
																		identityProvider.clientSecret,
																	),
																}),
												}
								const files =
									filesInput === undefined
										? document.files
										: yield* changeFiles(filesOf(document), filesInput)
								return {
									...document,
									...changes,
									identityProvider: provider,
									...(files === undefined ? {} : { files }),
								}
							}).pipe(
								Effect.provideService(Secrets, secrets),
								Effect.catchTag("SecretStorageError", () =>
									Effect.fail(SettingsApi.SettingsUnavailable.make({})),
								),
							),
					)
					yield* record(account, {
						action: "settings.updated",
						resource: platformKey,
						details: {
							changes: [
								...Object.keys(changes),
								...(identityProvider === undefined ? [] : ["identityProvider"]),
								...(filesInput === undefined ? [] : ["files"]),
							],
							version: updated.version,
						},
					})
					return Views.platform(updated)
				}).pipe(
					Effect.catchTag("SetupRequired", () =>
						Effect.fail(SettingsApi.SettingsUnavailable.make({})),
					),
				),
			)
			.handle("listPlatformOrganizations", ({ query }) =>
				organization
					.list({
						limit: query.limit ?? 50,
						...(query.after === undefined ? {} : { after: query.after }),
					})
					.pipe(
						Effect.mapError(() => PlatformApi.PlatformUnavailable.make({})),
					),
			)
			.handle("updatePlatformOrganization", ({ params, payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const updated = yield* organization
						.setStatus(params.organizationId, payload.status)
						.pipe(
							Effect.mapError((error) =>
								error._tag === "OrganizationNotFound"
									? error
									: PlatformApi.PlatformUnavailable.make({}),
							),
						)
					yield* record(account, {
						organizationId: updated.id,
						action: "organization.updated",
						resource: organizationKey(updated.id),
						details: { status: updated.status, by: "platform" },
					})
					return updated
				}),
			)
			.handle("listPlatformAdmins", () =>
				admins.list.pipe(
					Effect.map((items) => ({ items })),
					Effect.mapError(() => PlatformApi.PlatformUnavailable.make({})),
				),
			)
			.handle("addPlatformAdmin", ({ payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const added = yield* admins
						.add(payload.email)
						.pipe(
							Effect.mapError(() => PlatformApi.PlatformUnavailable.make({})),
						)
					yield* record(account, {
						action: "member.updated",
						resource: platformKey,
						details: { platformAdmin: "added", email: added.email },
					})
					return added
				}),
			)
			.handle("removePlatformAdmin", ({ params }) =>
				Effect.gen(function* () {
					const account = yield* Account
					yield* admins
						.remove(params.email)
						.pipe(
							Effect.mapError((error) =>
								error._tag === "PlatformAdminsUnavailable"
									? PlatformApi.PlatformUnavailable.make({})
									: error,
							),
						)
					yield* record(account, {
						action: "member.updated",
						resource: platformKey,
						details: { platformAdmin: "removed", email: params.email },
					})
				}),
			)
			.handle("listPlatformModels", () =>
				models
					.list(platformOwner)
					.pipe(Effect.map((items) => ({ items: items.map(modelView) }))),
			)
			.handle("getPlatformModel", ({ params }) =>
				Effect.map(findModel(params.modelId), modelView),
			)
			.handle("createPlatformModel", ({ payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const created = yield* models.create(platformOwner, payload)
					yield* record(account, {
						action: "model.created",
						resource: platformKey,
						details: { modelId: created.id, name: created.name },
					})
					return modelView(created)
				}),
			)
			.handle("updatePlatformModel", ({ params, payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const updated = yield* models.update(
						platformOwner,
						params.modelId,
						payload,
					)
					yield* record(account, {
						action: "model.updated",
						resource: platformKey,
						details: { modelId: updated.id, name: updated.name },
					})
					return modelView(updated)
				}),
			)
			.handle("deletePlatformModel", ({ params }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const model = yield* findModel(params.modelId)
					yield* models.delete(platformOwner, model.id)
					yield* record(account, {
						action: "model.deleted",
						resource: platformKey,
						details: { modelId: model.id, name: model.name },
					})
				}),
			)
			.handle("listPlatformModelProviders", () =>
				providers
					.list(platformOwner)
					.pipe(Effect.map((items) => ({ items: items.map(view) }))),
			)
			.handle("getPlatformModelProvider", ({ params }) =>
				Effect.map(findProvider(params.providerId), view),
			)
			.handle("createPlatformModelProvider", ({ payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const created = yield* providers.create(platformOwner, payload)
					yield* record(account, {
						action: "model_provider.created",
						resource: platformKey,
						details: { providerId: created.id, name: created.name },
					})
					return view(created)
				}),
			)
			.handle("updatePlatformModelProvider", ({ params, payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const updated = yield* providers.update(
						platformOwner,
						params.providerId,
						payload,
					)
					yield* record(account, {
						action: "model_provider.updated",
						resource: platformKey,
						details: { providerId: updated.id, name: updated.name },
					})
					return view(updated)
				}),
			)
			.handle("listPlatformModelPrices", ({ params }) =>
				Effect.gen(function* () {
					const provider = yield* findProvider(params.providerId)
					const items = yield* billing
						.prices(provider.id)
						.pipe(
							Effect.mapError(() => PlatformApi.PlatformUnavailable.make({})),
						)
					return { items }
				}),
			)
			.handle("setPlatformModelPrice", ({ params, payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const provider = yield* findProvider(params.providerId)
					if (!provider.models.some((link) => link.model === payload.model))
						return yield* ModelProvidersApi.ModelProviderInvalid.make({
							message: "The provider does not offer this model.",
						})
					const price = yield* billing
						.setPrice(provider.id, payload, account.userId)
						.pipe(
							Effect.mapError(() => PlatformApi.PlatformUnavailable.make({})),
						)
					yield* record(account, {
						action: "model_price.set",
						resource: platformKey,
						details: { providerId: provider.id, ...price },
					})
					return price
				}),
			)
			.handle("getPlatformOrganizationCredits", ({ params }) =>
				credits(billing.credits(params.organizationId), params.organizationId),
			)
			.handle("updatePlatformOrganizationCredits", ({ params, payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const updated = yield* credits(
						billing.setCreditsEnabled(params.organizationId, payload.enabled),
						params.organizationId,
					)
					yield* record(account, {
						organizationId: params.organizationId,
						action: "credits.updated",
						resource: organizationKey(params.organizationId),
						details: { enabled: payload.enabled },
					})
					return updated
				}),
			)
			.handle("grantPlatformOrganizationCredits", ({ params, payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const grant = yield* credits(
						billing.grantCredits(
							params.organizationId,
							payload,
							account.userId,
						),
						params.organizationId,
					)
					yield* record(account, {
						organizationId: params.organizationId,
						action: "credits.granted",
						resource: organizationKey(params.organizationId),
						details: {
							grantId: grant.id,
							amountMicros: grant.amountMicros,
							note: grant.note,
						},
					})
					return grant
				}),
			)
			.handle("deletePlatformModelProvider", ({ params }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const provider = yield* findProvider(params.providerId)
					const organizationIds = yield* allOrganizations.pipe(
						Effect.mapError(() => PlatformApi.PlatformUnavailable.make({})),
					)
					yield* checkUnused({ providerId: provider.id, organizationIds }).pipe(
						Effect.provideService(Settings, settings),
					)
					yield* providers.delete(platformOwner, provider.id)
					yield* record(account, {
						action: "model_provider.deleted",
						resource: platformKey,
						details: { providerId: provider.id, name: provider.name },
					})
				}),
			)
	}),
)

export const layer = group
