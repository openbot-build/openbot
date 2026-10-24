import { Settings as Api } from "@openbot-build/api"
import { Effect, Redacted } from "effect"
import type { Configuration } from "../auth/Model.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import type { FilesDocument, PlatformDocument } from "./Documents.ts"

/** The places of the sealed secrets in the platform settings. */
export const bindings = {
	authSecret: "openbot_settings:platform:authSecret",
	identityProviderSecret:
		"openbot_settings:platform:identityProvider.clientSecret",
	fileStorageSecret: "openbot_settings:platform:files.storage.secretAccessKey",
} as const

/**
 * The sign-in configuration that the platform settings describe.
 * The development entry point uses the local test account instead of a provider.
 */
export const authConfiguration = (input: {
	readonly document: PlatformDocument
	readonly development: boolean
}) =>
	Effect.gen(function* () {
		const secrets = yield* Secrets
		const { document } = input
		const shared = {
			publicOrigin: document.publicOrigin,
			secret: Redacted.make(
				yield* secrets.open(document.authSecret, bindings.authSecret),
			),
		}
		if (input.development)
			return { ...shared, mode: "development" } satisfies Configuration
		const provider = document.identityProvider
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

/**
 * The part of the platform settings that the running app is built from.
 * A change to it means a new app. Other settings are read on each request.
 */
export const appKey = (document: PlatformDocument) =>
	JSON.stringify([
		document.publicOrigin,
		document.authSecret,
		document.identityProvider,
	])

/** Applies a change of the file settings. A new secret key is sealed. */
export const changeFiles = (current: FilesDocument, input: Api.FilesInput) =>
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
		const secrets = yield* Secrets
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
