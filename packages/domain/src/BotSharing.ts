import { Schema } from "effect"
import { BotId } from "./BotId.ts"
import { InvitationId, InvitationStatus } from "./Invitation.ts"
import { ReturnTo } from "./ReturnTo.ts"
import { Email } from "./Email.ts"
import { Delivery } from "./Mail.ts"
import { SecretOutput } from "./Secret.ts"

/** The start of the secret of every Bot invitation link. */
export const InvitationSecretPrefix = "obai_"

/**
 * An invitation to use one Bot. With `email`, the person with this verified email can
 * accept it once. Without `email`, it is a link: everyone who has its secret can accept it,
 * until someone revokes it or it expires.
 */
export const BotInvitation = Schema.Struct({
	id: InvitationId,
	bot: BotId,
	email: Schema.NullOr(Schema.String),
	/** The first characters of the secret of a link, so people can tell links apart. */
	prefix: Schema.NullOr(Schema.String),
	/** A same-origin path where a client opens invitation links. */
	path: Schema.NullOr(ReturnTo),
	status: InvitationStatus,
	invitedBy: Schema.String,
	createdAt: Schema.String,
	/** A link without it never expires. */
	expiresAt: Schema.NullOr(Schema.String),
})
export type BotInvitation = typeof BotInvitation.Type
export const CreateBotInvitationRequest = Schema.Struct({
	/** Without it, the invitation is a link. */
	email: Schema.optionalKey(Email),
	/** Milliseconds since 1970. An email invitation always lasts 7 days. */
	expiresAt: Schema.optionalKey(Schema.Finite),
	/**
	 * A path on the public origin where your client opens invitation links.
	 * With it, a link has a full `url` that you can show as a QR code.
	 */
	path: Schema.optionalKey(ReturnTo),
})
export type CreateBotInvitationRequest = typeof CreateBotInvitationRequest.Type
/**
 * An invitation with the secret of its link. `url` is the public origin, then `path`,
 * then `#` and the secret, so the secret never reaches a server log.
 */
export const BotInvitationSecret = Schema.Struct({
	invitation: BotInvitation,
	secret: Schema.NullOr(SecretOutput),
	url: Schema.NullOr(Schema.String),
	/** Only present when creating an invitation by email. */
	delivery: Schema.optionalKey(Delivery),
})
export type BotInvitationSecret = typeof BotInvitationSecret.Type
export const AcceptBotInvitationRequest = Schema.Struct({
	/** The ID of an email invitation. */
	invitation: Schema.optionalKey(InvitationId),
	/** The secret of an invitation link. */
	secret: Schema.optionalKey(
		Schema.RedactedFromValue(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
		),
	),
	/**
	 * The organization where you use the Bot. You must be an active member of it.
	 * You can leave it out when you have only one organization.
	 */
	organization: Schema.optionalKey(Schema.String),
})
export type AcceptBotInvitationRequest = typeof AcceptBotInvitationRequest.Type
