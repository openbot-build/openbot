import type { Vaults as VaultsModel } from "@openbot-build/domain"
import { Context, type Effect, Schema } from "effect"

/**
 * The secret provider did not answer, refused the token, or has no such item or field.
 * Callers show the message. The cause stays inside OpenBot.
 */
export class VaultReadFailed extends Schema.TaggedError<
	VaultReadFailed,
	{ readonly brand: unique symbol }
>()("VaultReadFailed", {
	message: Schema.String,
	retry: Schema.Boolean,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** Reads one secret provider. It never writes to it. */
export interface Reader {
	/** Checks the address and the token. */
	readonly verify: Effect.Effect<void, VaultReadFailed>
	/** The values of these fields of one item. It fails when a field is missing. */
	readonly read: (
		source: VaultsModel.VaultItemSource,
		fields: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyMap<string, string>, VaultReadFailed>
}

/** Builds the reader of a secret provider from its secrets. Tests give their own. */
export class Readers extends Context.Service<
	Readers,
	{
		readonly make: (
			credentials: VaultsModel.SecretProviderCredentials,
		) => Reader
	}
>()("@openbot-build/apps-contract/vaults/Readers") {}
