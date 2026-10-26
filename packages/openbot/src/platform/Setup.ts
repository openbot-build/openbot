import { randomBytes } from "node:crypto"
import { Settings as Api } from "@openbot-build/api"
import { Effect, Option, Schema } from "effect"
import { hint, Secrets } from "../secrets/Secrets.ts"
import {
	type PlatformDocument,
	browserAuthDefaults,
} from "../settings/Documents.ts"
import { bindings } from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { PlatformAdmins } from "./PlatformAdmins.ts"

export interface Input {
	readonly publicOrigin: string
	/** None means that the platform has no sign-in provider of its own. */
	readonly identityProvider: Option.Option<{
		readonly providerId?: string | undefined
		readonly callbackPath?: string | undefined
		readonly scopes?: ReadonlyArray<string> | undefined
		readonly issuer: string
		readonly clientId: string
		readonly clientSecret: Option.Option<string>
	}>
	/** People with these verified emails become platform admins. */
	readonly adminEmails: ReadonlyArray<string>
	/** Migration setup binds known accounts without an email claim at first login. */
	readonly adminAccounts?:
		| ReadonlyArray<{ readonly userId: string; readonly email: string }>
		| undefined
	readonly browserAuth?:
		NonNullable<PlatformDocument["browserAuth"]> | undefined
	readonly memberSignupOrganizationId?: string | null | undefined
	readonly developerVerification?:
		NonNullable<PlatformDocument["developerVerification"]> | undefined
	/** Write the settings even when they exist. Use it only when no admin can sign in. */
	readonly force: boolean
	/**
	 * The sign-in secret to store. Without it, a new platform gets a random one,
	 * and an existing platform keeps its own.
	 */
	readonly authSecret?: string | undefined
}

/** The platform already has settings, and they are not the same. */
export class SetupAlreadyDone extends Schema.TaggedError<SetupAlreadyDone>()(
	"SetupAlreadyDone",
	{},
) {}
export class SetupInvalid extends Schema.TaggedError<SetupInvalid>()(
	"SetupInvalid",
	{ message: Schema.String },
) {}

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
		if (
			input.adminEmails.length === 0 &&
			(input.adminAccounts?.length ?? 0) === 0
		)
			return yield* SetupInvalid.make({
				message: "Name at least one platform admin email.",
			})
		const current = yield* settings.platform
		if (Option.isSome(current) && input.authSecret !== undefined) {
			const stored = yield* secrets.open(
				current.value.document.authSecret,
				bindings.authSecret,
			)
			if (stored !== input.authSecret)
				return yield* SetupInvalid.make({
					message:
						"Keep the existing sign-in secret. Rotate it through a separate offline procedure.",
				})
		}
		const sameAsCurrent = (document: PlatformDocument) =>
			document.publicOrigin === input.publicOrigin &&
			(input.browserAuth === undefined ||
				JSON.stringify(document.browserAuth ?? browserAuthDefaults) ===
					JSON.stringify(input.browserAuth)) &&
			(input.memberSignupOrganizationId === undefined ||
				(document.memberSignupOrganizationId ?? null) ===
					input.memberSignupOrganizationId) &&
			(input.developerVerification === undefined ||
				JSON.stringify(
					document.developerVerification ?? { metadataKeys: [], dnsLabels: [] },
				) === JSON.stringify(input.developerVerification)) &&
			Option.match(input.identityProvider, {
				onNone: () => document.identityProvider === null,
				onSome: (provider) =>
					document.identityProvider !== null &&
					document.identityProvider.issuer === provider.issuer &&
					document.identityProvider.clientId === provider.clientId &&
					(document.identityProvider.providerId ?? "oidc") ===
						(provider.providerId ?? "oidc") &&
					(document.identityProvider.callbackPath ?? "/auth/callback/oidc") ===
						(provider.callbackPath ?? "/auth/callback/oidc") &&
					(provider.scopes === undefined ||
						JSON.stringify(
							document.identityProvider.scopes ?? Api.defaultOidcScopes,
						) === JSON.stringify(provider.scopes)),
			})
		if (
			Option.isSome(current) &&
			!input.force &&
			!sameAsCurrent(current.value.document)
		)
			return yield* SetupAlreadyDone.make({})

		const identityProvider = yield* Option.match(input.identityProvider, {
			onNone: () => Effect.succeed(null),
			onSome: (provider) =>
				Effect.gen(function* () {
					const clientSecret = Option.isSome(provider.clientSecret)
						? yield* secrets.seal(
								provider.clientSecret.value,
								bindings.identityProviderSecret,
							)
						: null
					return {
						providerId: provider.providerId ?? "oidc",
						callbackPath: provider.callbackPath ?? "/auth/callback/oidc",
						scopes:
							provider.scopes ??
							(Option.isSome(current)
								? current.value.document.identityProvider?.scopes
								: undefined) ??
							Api.defaultOidcScopes,
						issuer: provider.issuer,
						clientId: provider.clientId,
						clientSecret,
						clientSecretHint: Option.match(provider.clientSecret, {
							onNone: () => null,
							onSome: hint,
						}),
					}
				}),
		})
		// Keep the current sign-in secret, so `--force` does not sign everyone out.
		const authSecret =
			input.authSecret !== undefined
				? yield* secrets.seal(input.authSecret, bindings.authSecret)
				: Option.isSome(current)
					? current.value.document.authSecret
					: yield* secrets.seal(
							randomBytes(32).toString("hex"),
							bindings.authSecret,
						)
		const document: PlatformDocument = {
			publicOrigin: input.publicOrigin,
			authSecret,
			identityProvider,
			browserAuth:
				input.browserAuth ??
				(Option.isSome(current)
					? current.value.document.browserAuth
					: undefined) ??
				browserAuthDefaults,
			memberSignupOrganizationId:
				input.memberSignupOrganizationId === undefined
					? ((Option.isSome(current)
							? current.value.document.memberSignupOrganizationId
							: null) ?? null)
					: input.memberSignupOrganizationId,
			developerVerification: input.developerVerification ??
				(Option.isSome(current)
					? current.value.document.developerVerification
					: undefined) ?? { metadataKeys: [], dnsLabels: [] },
			organizationCreation: Option.match(current, {
				onNone: () => "anyone" as const,
				onSome: (current) => current.document.organizationCreation,
			}),
			policyCeiling: Option.match(current, {
				onNone: () => [],
				onSome: (current) => current.document.policyCeiling,
			}),
			appRestrictions: Option.match(current, {
				onNone: () => [],
				onSome: (current) => current.document.appRestrictions,
			}),
		}
		const outcome: Outcome = Option.isNone(current)
			? (yield* settings.initializePlatform(document))
				? "created"
				: // Another instance ran setup at the same time.
					"unchanged"
			: input.force
				? (yield* settings.replacePlatform(document), "replaced")
				: "unchanged"
		for (const account of input.adminAccounts ?? []) yield* admins.bind(account)
		for (const email of input.adminEmails) yield* admins.add(email)
		return outcome
	})
