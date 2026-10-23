import { randomBytes } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { hint, Secrets } from "../secrets/Secrets.ts"
import type { PlatformDocument } from "../settings/Documents.ts"
import { bindings } from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { PlatformAdmins } from "./PlatformAdmins.ts"

export interface Input {
	readonly publicOrigin: string
	/** None means that the platform has no sign-in provider of its own. */
	readonly identityProvider: Option.Option<{
		readonly issuer: string
		readonly clientId: string
		readonly clientSecret: Option.Option<string>
	}>
	/** People with these verified emails become platform admins. */
	readonly adminEmails: ReadonlyArray<string>
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
		if (input.adminEmails.length === 0)
			return yield* SetupInvalid.make({
				message: "Name at least one platform admin email.",
			})
		const current = yield* settings.platform
		const sameAsCurrent = (document: PlatformDocument) =>
			document.publicOrigin === input.publicOrigin &&
			Option.match(input.identityProvider, {
				onNone: () => document.identityProvider === null,
				onSome: (provider) =>
					document.identityProvider !== null &&
					document.identityProvider.issuer === provider.issuer &&
					document.identityProvider.clientId === provider.clientId,
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
			...Option.match(current, {
				onNone: () => ({}),
				onSome: (current) =>
					current.document.codeMode === undefined
						? {}
						: { codeMode: current.document.codeMode },
			}),
			...Option.match(current, {
				onNone: () => ({}),
				onSome: (current) =>
					current.document.rateLimit === undefined
						? {}
						: { rateLimit: current.document.rateLimit },
			}),
			...Option.match(current, {
				onNone: () => ({}),
				onSome: (current) =>
					current.document.tokenRate === undefined
						? {}
						: { tokenRate: current.document.tokenRate },
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
		for (const email of input.adminEmails) yield* admins.add(email)
		return outcome
	})
