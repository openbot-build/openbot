import { Effect, Redacted } from "effect"
import type { Configuration } from "../auth/Model.ts"
import { Secrets } from "../secrets/Secrets.ts"
import type { PlatformDocument } from "./Documents.ts"

/** The places of the sealed secrets in the platform settings. */
export const bindings = {
	authSecret: "openbot_settings:platform:authSecret",
	identityProviderSecret:
		"openbot_settings:platform:identityProvider.clientSecret",
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
