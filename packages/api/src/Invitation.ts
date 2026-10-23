import { Schema } from "effect"

/**
 * The parts that invitations to an organization and invitations to a Bot share.
 * They live here, so the Bot and organization contracts do not import each other.
 */
export const InvitationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)
/** `revoked` means that an administrator took it back. An invitation that is too old is `expired`. */
export const InvitationStatus = Schema.Literals([
	"pending",
	"accepted",
	"declined",
	"revoked",
	"expired",
])
export type InvitationStatus = typeof InvitationStatus.Type
export class InvitationNotFound extends Schema.TaggedError<InvitationNotFound>()(
	"InvitationNotFound",
	{ invitationId: Schema.String },
) {}
/** The invitation cannot be used now, for example because it is too old or is for another email. */
export class InvitationInvalid extends Schema.TaggedError<InvitationInvalid>()(
	"InvitationInvalid",
	{ message: Schema.String },
) {}
