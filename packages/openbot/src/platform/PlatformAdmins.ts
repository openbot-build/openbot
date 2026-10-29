import type { Platform as PlatformModel } from "@openbot-build/domain"
import { Context, type Effect, pipe, Schema, String as Str } from "effect"

export class PlatformAdminsUnavailable extends Schema.TaggedError<
	PlatformAdminsUnavailable,
	{ readonly brand: unique symbol }
>()("PlatformAdminsUnavailable", { cause: Schema.Defect() }) {}

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
			ReadonlyArray<PlatformModel.PlatformAdmin>,
			PlatformAdminsUnavailable
		>
		/** Adds an email. Adding an email that is already there changes nothing. */
		readonly add: (
			email: string,
			providerId?: string,
		) => Effect.Effect<PlatformModel.PlatformAdmin, PlatformAdminsUnavailable>
		readonly remove: (
			email: string,
		) => Effect.Effect<
			void,
			| PlatformModel.PlatformAdminNotFound
			| PlatformModel.LastPlatformAdmin
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

export const normalizeEmail = (email: string) =>
	pipe(email, Str.trim, Str.toLowerCase)
