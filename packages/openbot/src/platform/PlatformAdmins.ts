import type { PlatformApi } from "@openbot-build/api"
import { Context, type Effect, Schema } from "effect"

export class PlatformAdminsUnavailable extends Schema.TaggedError<PlatformAdminsUnavailable>()(
	"PlatformAdminsUnavailable",
	{},
) {}

export interface Account {
	readonly id: string
	readonly email?: string | undefined
	readonly emailVerified?: boolean | undefined
}

/**
 * The people who manage the whole platform. They are not members of every
 * organization. They manage organizations only through `/v1/platform`.
 */
export class PlatformAdmins extends Context.Service<
	PlatformAdmins,
	{
		readonly list: Effect.Effect<
			ReadonlyArray<PlatformApi.PlatformAdmin>,
			PlatformAdminsUnavailable
		>
		/** Adds an email. Adding an email that is already there changes nothing. */
		readonly add: (
			email: string,
		) => Effect.Effect<PlatformApi.PlatformAdmin, PlatformAdminsUnavailable>
		readonly remove: (
			email: string,
		) => Effect.Effect<
			void,
			| PlatformApi.PlatformAdminNotFound
			| PlatformApi.LastPlatformAdmin
			| PlatformAdminsUnavailable
		>
		/**
		 * Whether the account is a platform admin. The first sign-in with a listed,
		 * verified email links the account to it.
		 */
		readonly check: (
			account: Account,
		) => Effect.Effect<boolean, PlatformAdminsUnavailable>
	}
>()("@openbot-build/openbot/platform/PlatformAdmins") {}

export const normalizeEmail = (email: string) => email.trim().toLowerCase()
