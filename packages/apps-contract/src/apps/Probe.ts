import type { AppConnections as Domain } from "@openbot-build/domain"
import type { Store } from "@openbot-build/protocol"
import { Context, type Effect } from "effect"

/** Checks whether an App connection needs authorization before it is saved. Tests give their own. */
export class Probe extends Context.Service<
	Probe,
	{
		readonly check: (input: {
			readonly connection: Store.UserConnection
		}) => Effect.Effect<
			| { readonly requiresAuthorization: false }
			| {
					readonly requiresAuthorization: true
					readonly scopes: ReadonlyArray<string>
					readonly resourceMetadataUrl?: string
			  },
			Domain.ConnectionConfigurationInvalid
		>
	}
>()("@openbot-build/apps-contract/apps/Probe") {}
