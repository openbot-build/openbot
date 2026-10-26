import { Settings as Api } from "@openbot-build/api"
import { Effect, Option, Redacted } from "effect"
import * as Failures from "../app/Failures.ts"
import type { Configuration } from "../auth/Model.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import type { FilesDocument, PlatformDocument } from "./Documents.ts"
import type { Settings } from "./Settings.ts"

/** The places of the sealed secrets in the platform settings. */
export const bindings = {
	authSecret: "openbot_settings:platform:authSecret",
	identityProviderSecret:
		"openbot_settings:platform:identityProvider.clientSecret",
	fileStorageSecret: "openbot_settings:platform:files.storage.secretAccessKey",
} as const

/**
 * Reads the public origin from the platform settings when it is needed. The
 * Settings service keeps them in a cache, and a change on any instance clears
 * that cache, so a new origin works at once. Nothing has to start again.
 */
export const publicOrigin = (
	settings: typeof Settings.Service,
): Effect.Effect<string, Api.SettingsUnavailable | Api.SetupRequired> =>
	Effect.flatMap(settings.platform, (platform) =>
		Option.match(platform, {
			onNone: () => Effect.fail(Api.SetupRequired.make({})),
			onSome: ({ document }) => Effect.succeed(document.publicOrigin),
		}),
	)

/**
 * Reads the public origin like `publicOrigin`, for a caller with its own
 * public error. The failure goes to the log first, because the public error
 * does not carry it.
 */
export const publicOriginOr = <E>(
	settings: typeof Settings.Service,
	unavailable: () => E,
): Effect.Effect<string, E> =>
	publicOrigin(settings).pipe(
		Failures.replace(
			"OpenBot could not read the public origin of the platform.",
			unavailable,
		),
	)

/**
 * Reads the public origin while the server answers a request, for code that
 * has no error for it. The setup check of the server read the platform
 * settings for the same request a moment before, from the same cache, so a
 * failure here is a defect.
 */
export const publicOriginInRequest = (settings: typeof Settings.Service) =>
	Effect.orDie(publicOrigin(settings))

/**
 * The part of the platform settings that sign-in is made from. When it
 * changes, sign-in needs a new Better Auth instance. Other settings are read
 * each time they are used.
 */
export type SignInSettings = Pick<
	PlatformDocument,
	"publicOrigin" | "authSecret" | "identityProvider"
>

/**
 * The key of the sign-in instance of these platform settings. It is a plain
 * object, and Effect compares plain objects by value, so equal settings give
 * equal keys.
 */
export const signInKey = (document: PlatformDocument): SignInSettings => ({
	publicOrigin: document.publicOrigin,
	authSecret: document.authSecret,
	identityProvider: document.identityProvider,
})

/**
 * The sign-in configuration that the platform settings describe.
 * The development entry point uses the local test account instead of a provider.
 */
export const authConfiguration = (
	secrets: typeof Secrets.Service,
	input: {
		readonly settings: SignInSettings
		readonly development: boolean
	},
) =>
	Effect.gen(function* () {
		const { settings } = input
		const shared = {
			publicOrigin: settings.publicOrigin,
			secret: Redacted.make(
				yield* secrets.open(settings.authSecret, bindings.authSecret),
			),
		}
		if (input.development)
			return { ...shared, mode: "development" } satisfies Configuration
		const provider = settings.identityProvider
		if (provider === null)
			return { ...shared, mode: "none" } satisfies Configuration
		const clientSecret =
			provider.clientSecret === null
				? undefined
				: Redacted.make(
						yield* secrets.open(
							provider.clientSecret,
							bindings.identityProviderSecret,
						),
					)
		return {
			...shared,
			mode: "oidc",
			issuer: provider.issuer,
			clientId: provider.clientId,
			...(clientSecret === undefined ? {} : { clientSecret }),
		} satisfies Configuration
	})

/** Applies a change of the file settings. A new secret key is sealed. */
export const changeFiles = (
	secrets: typeof Secrets.Service,
	current: FilesDocument,
	input: Api.FilesInput,
) =>
	Effect.gen(function* () {
		const { storage, ...limits } = input
		const next = { ...current, ...limits }
		if (storage === undefined) return next
		if (storage === null) return { ...next, storage: null }
		const { secretAccessKey, ...fields } = storage
		if (secretAccessKey === undefined) {
			if (current.storage === null)
				return yield* Api.SettingsInvalid.make({
					message: "New file storage needs a secretAccessKey.",
				})
			return {
				...next,
				storage: {
					...fields,
					secretAccessKey: current.storage.secretAccessKey,
					secretAccessKeyHint: current.storage.secretAccessKeyHint,
				},
			}
		}
		return {
			...next,
			storage: {
				...fields,
				secretAccessKey: yield* secrets.seal(
					secretAccessKey,
					bindings.fileStorageSecret,
				),
				secretAccessKeyHint: hint(secretAccessKey),
			},
		}
	})
