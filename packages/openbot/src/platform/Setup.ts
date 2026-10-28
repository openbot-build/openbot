import { Settings as SettingsModel } from "@openbot-build/domain"

import { Authorization } from "@openbot-build/domain"
import { Crypto, Effect, Option, Redacted, Schema } from "effect"
import { Hex } from "effect/encoding"
import { hint, Secrets } from "../secrets/Secrets.ts"
import {
	browserAuthOf,
	filesDefaults,
	filesOf,
	type PlatformDocument,
} from "../settings/Documents.ts"
import { bindings, changeFiles } from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { PlatformAdmins } from "./PlatformAdmins.ts"

export interface Input {
	readonly publicOrigin: string
	/** None keeps the existing provider, or leaves a new platform without one. */
	readonly identityProvider: Option.Option<{
		readonly providerId?: string
		readonly callbackPath?: string
		readonly scopes?: typeof SettingsModel.OidcScopes.Type
		readonly issuer: string
		readonly clientId: string
		readonly clientSecret: Option.Option<Redacted.Redacted<string>>
	}>
	/** Fixed server configuration can explicitly replace a confidential client with a public one. */
	readonly preserveIdentityProviderSecret?: boolean
	readonly memberSignupOrganizationId?: string | null
	readonly browserAuth?: SettingsModel.BrowserAuth
	/** People with these verified emails become platform admins. */
	readonly adminEmails: ReadonlyArray<string>
	/** Write the settings even when they exist. Use it only when no admin can sign in. */
	readonly force: boolean
	/**
	 * The sign-in secret to store. None means that a new platform gets a random
	 * one, and an existing platform keeps its own.
	 */
	readonly authSecret: Option.Option<Redacted.Redacted<string>>
	/**
	 * The object storage for files. None means that a new platform has none, and
	 * an existing platform keeps its own.
	 */
	readonly fileStorage: Option.Option<SettingsModel.FileStorageInput>
}

/** The platform already has settings, and they are not the same. */
export class SetupAlreadyDone extends Schema.TaggedError<
	SetupAlreadyDone,
	{ readonly brand: unique symbol }
>()("SetupAlreadyDone", {}) {}
export class SetupInvalid extends Schema.TaggedError<
	SetupInvalid,
	{ readonly brand: unique symbol }
>()("SetupInvalid", { message: Schema.String }) {}

export type Outcome = "created" | "unchanged" | "replaced"

/**
 * Writes the first platform settings and platform admins.
 * Anyone who can run it already has the database and the secret keys,
 * so it needs no other sign-in. Running it again with the same input changes nothing.
 */
export const run = (input: Input) =>
	Effect.gen(function* () {
		const settings = yield* Settings
		const secrets = yield* Secrets
		const admins = yield* PlatformAdmins
		const crypto = yield* Crypto.Crypto
		if (input.adminEmails.length === 0)
			return yield* SetupInvalid.make({
				message: "Name at least one platform admin email.",
			})
		const current = yield* settings.platform
		const sameStorage = (document: PlatformDocument) =>
			Option.match(input.fileStorage, {
				onNone: () => true,
				onSome: (wanted) => {
					const storage = filesOf(document).storage
					return (
						storage !== null &&
						storage.endpoint === wanted.endpoint &&
						storage.publicEndpoint === wanted.publicEndpoint &&
						storage.region === wanted.region &&
						storage.bucket === wanted.bucket &&
						storage.accessKeyId === wanted.accessKeyId &&
						storage.forcePathStyle === wanted.forcePathStyle
					)
				},
			})
		const sameAsCurrent = (document: PlatformDocument) =>
			document.publicOrigin === input.publicOrigin &&
			(input.memberSignupOrganizationId === undefined ||
				(document.memberSignupOrganizationId ?? null) ===
					input.memberSignupOrganizationId) &&
			(input.browserAuth === undefined ||
				(browserAuthOf(document).sessionCookie ===
					input.browserAuth.sessionCookie &&
					browserAuthOf(document).loginCookie ===
						input.browserAuth.loginCookie &&
					browserAuthOf(document).sessionTtlMs ===
						input.browserAuth.sessionTtlMs)) &&
			sameStorage(document) &&
			Option.match(input.identityProvider, {
				onNone: () => true,
				onSome: (provider) =>
					document.identityProvider !== null &&
					document.identityProvider.issuer === provider.issuer &&
					document.identityProvider.clientId === provider.clientId &&
					(provider.providerId === undefined ||
						(document.identityProvider.providerId ?? "oidc") ===
							provider.providerId) &&
					(provider.callbackPath === undefined ||
						(document.identityProvider.callbackPath ??
							"/auth/callback/oidc") === provider.callbackPath) &&
					(provider.scopes === undefined ||
						JSON.stringify(
							document.identityProvider.scopes ??
								SettingsModel.defaultOidcScopes,
						) === JSON.stringify(provider.scopes)),
			})
		if (
			Option.isSome(current) &&
			!input.force &&
			!sameAsCurrent(current.value.document)
		)
			return yield* SetupAlreadyDone.make({})

		const previousProvider =
			Option.getOrUndefined(current)?.document.identityProvider
		const preservedSecret =
			input.preserveIdentityProviderSecret !== false &&
			Option.isSome(input.identityProvider) &&
			previousProvider?.issuer === input.identityProvider.value.issuer &&
			previousProvider?.clientId === input.identityProvider.value.clientId
				? previousProvider
				: null
		const identityProvider = yield* Option.match(input.identityProvider, {
			onNone: () =>
				Effect.succeed(
					Option.getOrUndefined(current)?.document.identityProvider ?? null,
				),
			onSome: (provider) =>
				Effect.transposeOption(
					Option.map(provider.clientSecret, (secret) =>
						secrets.seal(
							Redacted.value(secret),
							bindings.identityProviderSecret,
						),
					),
				).pipe(
					Effect.map((clientSecret) => ({
						providerId:
							provider.providerId ??
							Option.getOrUndefined(current)?.document.identityProvider
								?.providerId ??
							"oidc",
						callbackPath:
							provider.callbackPath ??
							Option.getOrUndefined(current)?.document.identityProvider
								?.callbackPath ??
							"/auth/callback/oidc",
						scopes:
							provider.scopes ??
							Option.getOrUndefined(current)?.document.identityProvider
								?.scopes ??
							SettingsModel.defaultOidcScopes,
						issuer: provider.issuer,
						clientId: provider.clientId,
						clientSecret:
							Option.getOrNull(clientSecret) ??
							preservedSecret?.clientSecret ??
							null,
						clientSecretHint: Option.match(provider.clientSecret, {
							onNone: () => preservedSecret?.clientSecretHint ?? null,
							onSome: (secret) => hint(Redacted.value(secret)),
						}),
					})),
				),
		})
		const authSecret = yield* Option.match(input.authSecret, {
			onSome: (secret) =>
				secrets.seal(Redacted.value(secret), bindings.authSecret),
			// Keep the current sign-in secret, so `--force` does not sign everyone out.
			onNone: () =>
				Option.match(current, {
					onSome: ({ document }) => Effect.succeed(document.authSecret),
					onNone: () =>
						crypto.randomBytes(32).pipe(
							// A machine with no secure random numbers cannot make a secret, so this is a defect.
							Effect.orDie,
							Effect.flatMap((bytes) =>
								secrets.seal(Hex.encode(bytes), bindings.authSecret),
							),
						),
				}),
		})
		// Setup changes only the files storage. The current document already holds the current files.
		const changedFiles = yield* Option.match(input.fileStorage, {
			onNone: () => Effect.succeed({}),
			onSome: (storage) =>
				changeFiles(
					secrets,
					Option.match(current, {
						onNone: () => filesDefaults,
						onSome: ({ document }) => filesOf(document),
					}),
					{ storage },
				).pipe(Effect.map((files) => ({ files }))),
		})
		// Setup keeps every other setting of the current document, or uses the defaults.
		const kept: Omit<
			PlatformDocument,
			"publicOrigin" | "authSecret" | "identityProvider"
		> = Option.match(current, {
			onNone: () => ({
				organizationCreation: "anyone",
				ceiling: Authorization.emptyPolicy,
				appRestrictions: [],
			}),
			onSome: ({ document }) => document,
		})
		const document: PlatformDocument = {
			...kept,
			...(input.memberSignupOrganizationId === undefined
				? {}
				: { memberSignupOrganizationId: input.memberSignupOrganizationId }),
			...(input.browserAuth === undefined
				? {}
				: { browserAuth: input.browserAuth }),
			...changedFiles,
			publicOrigin: input.publicOrigin,
			authSecret,
			identityProvider,
		}
		const outcome = yield* Option.match(current, {
			onNone: () =>
				Effect.map(settings.initializePlatform(document), (created): Outcome =>
					created
						? "created"
						: // Another instance ran setup at the same time.
							"unchanged",
				),
			onSome: (): Effect.Effect<Outcome, SettingsModel.SettingsUnavailable> =>
				input.force
					? Effect.as(settings.replacePlatform(document), "replaced")
					: Effect.succeed("unchanged"),
		})
		for (const email of input.adminEmails) yield* admins.add(email)
		return outcome
	})
