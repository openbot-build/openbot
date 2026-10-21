import { Context, Effect, type Redacted } from "effect"
import type {
	AuthUnavailable,
	CredentialRejected,
	SessionInfo,
} from "./Model.js"

export class Auth extends Context.Service<
	Auth,
	{
		/** The Better Auth Web handler. Platform mounts it at `/auth/*`. */
		readonly handler: (request: Request) => Promise<Response>
		readonly resolveSession: (
			credential: Redacted.Redacted<string>,
			options?: { readonly refresh: boolean },
		) => Effect.Effect<
			SessionInfo & { readonly setCookies: ReadonlyArray<string> },
			CredentialRejected | AuthUnavailable
		>
	}
>()("@openbot-build/platform/auth/Auth") {}
