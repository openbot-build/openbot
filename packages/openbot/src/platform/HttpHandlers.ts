import { Schema } from "effect"
import { CreditConflict } from "@openbot-build/domain/Billing"
import { Access } from "../access/Access.ts"
import { ProviderOAuth } from "../models/ProviderOAuth.ts"
import { Mail } from "../mail/Mail.ts"
import { Model, Provider } from "@openbot-build/core"
import { Redacted } from "effect"
import {
	ModelProvidersApi,
	OpenBotApi,
	PlatformApi,
	Settings as SettingsApi,
} from "@openbot-build/api"

import { Account, type AccountCaller } from "@openbot-build/domain"
import { Array as Arr, Effect, Option, Stream, Struct } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../errors/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import {
	Billing,
	type BillingStorageError,
	type OrganizationMissing,
} from "../billing/Billing.ts"
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
import { bindings, changeFiles, changeMail } from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import * as Views from "../settings/Views.ts"
import { PlatformAdmins } from "./PlatformAdmins.ts"

/** Platform actions go to this audit log, apart from the logs of organizations. */
export const platformLog = "platform"

/** Logs an inside failure, then fails with `PlatformUnavailable` in its place. */
const unavailable = (message: string) =>
	Failures.replace(message, () => PlatformApi.PlatformUnavailable.make({}))
/**
 * The same for one failure that `Effect.catchTag` takes out, so the other
 * failures, such as a missing organization, keep their meaning.
 */
const unavailableFailure =
	(message: string) =>
	<E>(error: E) =>
		Effect.fail(error).pipe(unavailable(message))

const group = HttpApiBuilder.group(OpenBotApi, "platform", (handlers) =>
	Effect.gen(function* () {
		const settings = yield* Settings
		const access = yield* Access
		const mailService = yield* Mail
		const secrets = yield* Secrets
		const admins = yield* PlatformAdmins
		const organization = yield* Organization
		const providers = yield* ModelProviders
		const oauth = yield* ProviderOAuth
		const models = yield* Models
		const audit = yield* AuditLog
		const billing = yield* Billing
		const credits = <A>(
			effect: Effect.Effect<A, BillingStorageError | OrganizationMissing>,
			organizationId: string,
			message: string,
		) =>
			effect.pipe(
				Effect.catchTags({
					OrganizationMissing: () =>
						Effect.fail(
							PlatformApi.OrganizationNotFound.make({ organizationId }),
						),
					BillingStorageError: unavailableFailure(message),
				}),
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
						...account,
						organizationId: input.organizationId ?? platformLog,
					},
					resource: input.resource,
					details: input.details,
				})
				.pipe(unavailable("Could not write the audit log"))
		const current = settings.platform.pipe(
			Effect.flatMap(
				Effect.fromOption(() => SettingsApi.SettingsUnavailable.make({})),
			),
		)
		const findProvider = (providerId: string) =>
			providers.get(platformOwner, providerId).pipe(
				Effect.flatMap(
					Effect.fromOption(() =>
						ModelProvidersApi.ModelProviderNotFound.make({
							providerId: Provider.Id.make(providerId),
						}),
					),
				),
			)
		const findModel = (modelId: string) =>
			models.get(platformOwner, modelId).pipe(
				Effect.flatMap(
					Effect.fromOption(() =>
						ModelProvidersApi.ModelNotFound.make({
							modelId: Model.Id.make(modelId),
						}),
					),
				),
			)
		/** Every organization, page by page. */
		const allOrganizations = Stream.paginate(Option.none<string>(), (after) =>
			organization
				.list({
					limit: 100,
					...Option.match(after, {
						onNone: () => ({}),
						onSome: (after) => ({ after }),
					}),
				})
				.pipe(
					Effect.map(
						(page) =>
							[
								Arr.map(page.items, (item) => item.id),
								Option.map(Option.fromNullOr(page.next), Option.some),
							] as const,
					),
				),
		).pipe(Stream.runCollect)

		// Write handlers do not stop when the client goes away, so a change
		// always gets its audit entry.
		return handlers
			.handle("startPlatformProviderAuthorization", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Account
					return yield* oauth.start(
						platformOwner,
						params.providerId,
						caller.userId,
						payload,
					)
				}),
			)
			.handle(
				"completePlatformProviderAuthorization",
				({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Account
						yield* oauth.complete(
							platformOwner,
							params.providerId,
							caller.userId,
							params.authorizationId,
							payload,
						)
						const updated = yield* findProvider(params.providerId)
						yield* record(caller, {
							action: "model_provider.updated",
							resource: platformKey,
							details: { providerId: updated.id, name: updated.name },
						})
						return view(updated)
					}),
				{ uninterruptible: true },
			)
			.handle(
				"disconnectPlatformProviderOAuth",
				({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Account
						const result = yield* oauth.disconnect(
							platformOwner,
							params.providerId,
						)
						const updated = yield* findProvider(params.providerId)
						yield* record(caller, {
							action: "model_provider.updated",
							resource: platformKey,
							details: { providerId: updated.id, name: updated.name },
						})
						return result
					}),
				{ uninterruptible: true },
			)
			.handle("getPlatformProviderAvailableModels", ({ params }) =>
				oauth.models(platformOwner, params.providerId),
			)

			.handle("sendTestMail", ({ payload }) => mailService.test(payload.to))
			.handle("getPlatformSettings", () => Effect.map(current, Views.platform))
			.handle(
				"updatePlatformSettings",
				({ payload }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const {
							expectedVersion,
							identityProvider,
							files: filesInput,
							mail: mailInput,
							...changes
						} = payload
						if (payload.registration !== undefined)
							yield* access
								.validateProvider(payload.registration.provider)
								.pipe(
									Failures.replace("The role mappings are invalid.", () =>
										SettingsApi.SettingsInvalid.make({
											message: "The role mappings are invalid.",
										}),
									),
								)
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
																		document.identityProvider
																			?.clientSecretHint ?? null,
																}
															: identityProvider.clientSecret === null
																? { clientSecret: null, clientSecretHint: null }
																: {
																		clientSecret: yield* secrets.seal(
																			Redacted.value(
																				identityProvider.clientSecret,
																			),
																			bindings.identityProviderSecret,
																		),
																		clientSecretHint: hint(
																			Redacted.value(
																				identityProvider.clientSecret,
																			),
																		),
																	}),
													}
									const files =
										filesInput === undefined
											? document.files
											: yield* changeFiles(
													secrets,
													filesOf(document),
													filesInput,
												)
									const mail =
										mailInput === undefined
											? document.mail
											: yield* changeMail(
													secrets,
													document.mail ?? null,
													mailInput,
												)
									return {
										...document,
										...changes,
										identityProvider: provider,
										...(files === undefined ? {} : { files }),
										...(mail === undefined ? {} : { mail }),
									}
								}).pipe(
									Effect.catchTag("SecretStorageError", (error) =>
										Effect.fail(error).pipe(
											Failures.replace("Could not seal a platform secret", () =>
												SettingsApi.SettingsUnavailable.make({}),
											),
										),
									),
								),
						)
						yield* record(account, {
							action: "settings.updated",
							resource: platformKey,
							details: {
								changes: [
									...Struct.keys(changes),
									...(identityProvider === undefined
										? []
										: ["identityProvider"]),
									...(filesInput === undefined ? [] : ["files"]),
									...(mailInput === undefined ? [] : ["mail"]),
								],
								version: updated.version,
							},
						})
						if (payload.registration !== undefined)
							yield* access
								.record(
									"registration.settings_changed",
									account.userId,
									"platform",
								)
								.pipe(unavailable("Could not write the access audit log"))
						return Views.platform(updated)
					}).pipe(
						Effect.catchTag("SetupRequired", () =>
							Effect.fail(SettingsApi.SettingsUnavailable.make({})),
						),
					),
				{ uninterruptible: true },
			)
			.handle("listPlatformOrganizations", ({ query }) =>
				organization
					.list({
						limit: query.limit ?? 50,
						...(query.after === undefined ? {} : { after: query.after }),
					})
					.pipe(unavailable("Could not list the organizations")),
			)
			.handle(
				"updatePlatformOrganization",
				({ params, payload }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const updated = yield* organization
							.setStatus(params.organizationId, payload.status)
							.pipe(
								Effect.catchTag(
									"OrganizationUnavailable",
									unavailableFailure(
										"Could not change the status of an organization",
									),
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
				{ uninterruptible: true },
			)
			.handle("listPlatformAdmins", () =>
				admins.list.pipe(
					Effect.map((items) => ({ items })),
					unavailable("Could not list the platform admins"),
				),
			)
			.handle(
				"addPlatformAdmin",
				({ payload }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const added = yield* admins
							.add(payload.email, payload.providerId)
							.pipe(unavailable("Could not add a platform admin"))
						yield* record(account, {
							action: "member.updated",
							resource: platformKey,
							details: { platformAdmin: "added", email: added.email },
						})
						return added
					}),
				{ uninterruptible: true },
			)
			.handle(
				"removePlatformAdmin",
				({ params }) =>
					Effect.gen(function* () {
						const account = yield* Account
						yield* admins
							.remove(params.email)
							.pipe(
								Effect.catchTag(
									"PlatformAdminsUnavailable",
									unavailableFailure("Could not remove a platform admin"),
								),
							)
						yield* record(account, {
							action: "member.updated",
							resource: platformKey,
							details: { platformAdmin: "removed", email: params.email },
						})
					}),
				{ uninterruptible: true },
			)
			.handle("listPlatformModels", () =>
				models
					.list(platformOwner)
					.pipe(Effect.map((items) => ({ items: Arr.map(items, modelView) }))),
			)
			.handle("getPlatformModel", ({ params }) =>
				Effect.map(findModel(params.modelId), modelView),
			)
			.handle(
				"createPlatformModel",
				({ payload }) =>
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
				{ uninterruptible: true },
			)
			.handle(
				"updatePlatformModel",
				({ params, payload }) =>
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
				{ uninterruptible: true },
			)
			.handle(
				"deletePlatformModel",
				({ params }) =>
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
				{ uninterruptible: true },
			)
			.handle("listPlatformModelProviders", () =>
				providers
					.list(platformOwner)
					.pipe(Effect.map((items) => ({ items: Arr.map(items, view) }))),
			)
			.handle("getPlatformModelProvider", ({ params }) =>
				Effect.map(findProvider(params.providerId), view),
			)
			.handle(
				"createPlatformModelProvider",
				({ payload }) =>
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
				{ uninterruptible: true },
			)
			.handle(
				"updatePlatformModelProvider",
				({ params, payload }) =>
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
				{ uninterruptible: true },
			)
			.handle("listPlatformModelPrices", ({ params }) =>
				Effect.gen(function* () {
					const provider = yield* findProvider(params.providerId)
					const items = yield* billing
						.prices(provider.id)
						.pipe(unavailable("Could not read the model prices"))
					return { items }
				}),
			)
			.handle(
				"setPlatformModelPrice",
				({ params, payload }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const provider = yield* findProvider(params.providerId)
						if (
							!Arr.some(provider.models, (link) => link.model === payload.model)
						)
							return yield* ModelProvidersApi.ModelProviderInvalid.make({
								message: "The provider does not offer this model.",
							})
						const price = yield* billing
							.setPrice(provider.id, payload, account.userId)
							.pipe(unavailable("Could not set the model price"))
						yield* record(account, {
							action: "model_price.set",
							resource: platformKey,
							details: { providerId: Provider.Id.make(provider.id), ...price },
						})
						return price
					}),
				{ uninterruptible: true },
			)
			.handle("getPlatformOrganizationCredits", ({ params }) =>
				credits(
					billing.credits(params.organizationId),
					params.organizationId,
					"Could not read the credits of an organization",
				),
			)
			.handle(
				"updatePlatformOrganizationCredits",
				({ params, payload }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const updated = yield* credits(
							billing.setCreditsEnabled(params.organizationId, payload.enabled),
							params.organizationId,
							"Could not change the credits of an organization",
						)
						yield* record(account, {
							organizationId: params.organizationId,
							action: "credits.updated",
							resource: organizationKey(params.organizationId),
							details: { enabled: payload.enabled },
						})
						return updated
					}),
				{ uninterruptible: true },
			)
			.handle(
				"grantPlatformOrganizationCredits",
				({ params, payload }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const grant = yield* credits(
							billing
								.grantCredits(params.organizationId, payload, account.userId)
								.pipe(Effect.catchTag("CreditConflict", Effect.succeed)),
							params.organizationId,
							"Could not grant credits to an organization",
						)
						if (Schema.is(CreditConflict)(grant)) return yield* grant
						return grant
					}),
				{ uninterruptible: true },
			)
			.handle(
				"deletePlatformModelProvider",
				({ params }) =>
					Effect.gen(function* () {
						const account = yield* Account
						const provider = yield* findProvider(params.providerId)
						const organizationIds = yield* allOrganizations.pipe(
							unavailable("Could not list the organizations"),
						)
						yield* checkUnused(settings, {
							providerId: Provider.Id.make(provider.id),
							organizationIds,
						})
						yield* provider.kind === "chatgpt"
							? oauth.remove(platformOwner, provider.id)
							: providers.delete(platformOwner, provider.id)
						yield* record(account, {
							action: "model_provider.deleted",
							resource: platformKey,
							details: {
								providerId: Provider.Id.make(provider.id),
								name: provider.name,
							},
						})
					}),
				{ uninterruptible: true },
			)
	}),
)

export const layer = group
