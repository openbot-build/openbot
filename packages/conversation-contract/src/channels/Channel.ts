import { Schema } from "effect"

/** A chat with one person, or a group chat. */
export const ConversationKind = Schema.Literals(["direct", "group"])

export type ConversationKind = typeof ConversationKind.Type
