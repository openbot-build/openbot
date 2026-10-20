import { Context, Schema } from "effect"

export const Caller = Schema.Struct({
	userId: Schema.String,
	tenantId: Schema.String,
})
export class Identity extends Context.Service<Identity, typeof Caller.Type>()(
	"@openbot-build/platform-api/Identity",
) {}
