import { Context, Effect, type Redacted } from "effect"
import type {
	AuthUnavailable,
	AuthRequestInvalid,
	CredentialRejected,
	SessionInfo,
} from "./Model.js"

export class Auth extends Context.Service<
	Auth,
	{
		readonly startLogin: (
			headers: Headers,
			returnTo?: string,
		) => Effect.Effect<Response, AuthUnavailable | AuthRequestInvalid>
		readonly completeLogin: (
			url: string,
			headers: Headers,
		) => Effect.Effect<Response, AuthUnavailable>
		readonly resolveSession: (
			credential: Redacted.Redacted<string>,
			options?: { readonly refresh: boolean },
		) => Effect.Effect<
			SessionInfo & { readonly setCookies: ReadonlyArray<string> },
			CredentialRejected | AuthUnavailable
		>
		readonly logout: (
			credential: Redacted.Redacted<string>,
		) => Effect.Effect<Response, AuthUnavailable>
	}
>()("@openbot-build/platform/auth/Auth") {}
