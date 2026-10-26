import { Context, type Effect, type Option, type Redacted } from "effect"
import type {
	AuthUnavailable,
	CredentialRejected,
	SessionInfo,
} from "./Model.ts"

/**
 * Sign-in with Better Auth. Each call uses the sign-in configuration of the
 * current platform settings, so a change to them works on the next call.
 */
export class Auth extends Context.Service<
	Auth,
	{
		/** The Better Auth Web handler. OpenBot mounts it at `/auth/*`. */
		readonly handler: (request: Request) => Promise<Response>
		/** The provider for a sign-in: the SSO connection of the email domain, or the platform provider. */
		readonly signInProvider: (
			email: string | undefined,
		) => Effect.Effect<Option.Option<string>, AuthUnavailable>
		/** The address of the provider, and the cookie that keeps the sign-in state. */
		readonly startSignIn: (input: {
			readonly providerId: string
			readonly returnTo?: string | undefined
		}) => Effect.Effect<
			{ readonly url: string; readonly setCookies: ReadonlyArray<string> },
			AuthUnavailable
		>
		readonly resolveSession: (
			credential: Redacted.Redacted<string>,
			options?: { readonly refresh: boolean },
		) => Effect.Effect<
			SessionInfo & { readonly setCookies: ReadonlyArray<string> },
			CredentialRejected | AuthUnavailable
		>
	}
>()("@openbot-build/openbot/auth/Auth") {}
