import { Schema } from "effect"

/** The result of one mail send. `sent` means that the mail server accepted it. */
export const Delivery = Schema.Struct({
	status: Schema.Literals(["sent", "disabled", "failed"]),
})
export type Delivery = typeof Delivery.Type
