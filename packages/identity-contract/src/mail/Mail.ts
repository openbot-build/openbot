import type { Mail as MailModel } from "@openbot-build/domain"
import { Context, Effect } from "effect"

export interface Invitation {
	readonly id: string
	readonly email: string
	readonly organizationName: string
	readonly botName?: string
	readonly expiresAt: number
}

/** A delivery result never changes whether the invitation was saved. */
export class Mail extends Context.Service<
	Mail,
	{
		readonly invitation: (
			input: Invitation,
		) => Effect.Effect<MailModel.Delivery>
		readonly signInCode: (
			to: string,
			code: string,
		) => Effect.Effect<MailModel.Delivery>
		readonly test: (to: string) => Effect.Effect<MailModel.Delivery>
	}
>()("@openbot-build/identity-contract/mail/Mail") {}
