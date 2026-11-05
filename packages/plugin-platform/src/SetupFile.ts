import { Settings as Model } from "@openbot-build/domain"
import * as Access from "@openbot-build/domain/Access"
import { Effect, type FileSystem, Option, Schema } from "effect"
import { SetupInvalid } from "./Setup.ts"

/** Shared settings are written once, then read from the database by every server. */
export const SetupFile = Schema.fromJsonString(
	Schema.Struct({
		publicOrigin: Model.PublicOrigin,
		identityProvider: Schema.optionalKey(
			Schema.NullOr(Model.IdentityProviderInput),
		),
		adminEmails: Schema.Array(Schema.NonEmptyString).check(
			Schema.isMinLength(1),
		),
		adminProvider: Schema.optionalKey(Schema.NonEmptyString),
		fileStorage: Schema.optionalKey(Model.FileStorageInput),
		registration: Schema.optionalKey(Access.Registration),
		mail: Schema.optionalKey(Schema.NullOr(Model.MailInput)),
	}),
)

export const decode = (text: string) =>
	Schema.decodeEffect(SetupFile)(text, {
		onExcessProperty: "error",
	}).pipe(
		// Schema errors may contain secret values from the file.
		Effect.catchTag("SchemaError", () =>
			Effect.fail(
				SetupInvalid.make({
					message: "The setup file is not valid. Check its fields and values.",
				}),
			),
		),
		Effect.map(({ identityProvider, fileStorage, ...settings }) => ({
			...settings,
			adminProvider: settings.adminProvider ?? "oidc",
			identityProvider: Option.map(
				Option.fromNullishOr(identityProvider),
				(provider) => ({
					...provider,
					clientSecret: Option.fromNullishOr(provider.clientSecret),
				}),
			),
			fileStorage: Option.fromUndefinedOr(fileStorage),
		})),
	)

export const read = (fs: FileSystem.FileSystem, path: string) =>
	fs.readFileString(path).pipe(Effect.flatMap(decode))
