import { Array as Arr, Cause, Context, Effect, Layer } from "effect"
import { AppCalls } from "@openbot-build/domain"
import { Settings } from "../settings/Settings.ts"
import * as Report from "../errors/Report.ts"

/**
 * Only the organization says which App tools only read, in its `appReadRules`
 * setting. App annotations never do.
 */
export class ActionPolicy extends Context.Service<
	ActionPolicy,
	{
		readonly isRead: (input: {
			readonly organizationId: string
			readonly source: AppCalls.Source
		}) => Effect.Effect<boolean>
	}
>()("@openbot-build/openbot/apps/ActionPolicy") {}

export const layer = Layer.effect(
	ActionPolicy,
	Effect.gen(function* () {
		const settings = yield* Settings
		const report = yield* Report.make
		return ActionPolicy.of({
			isRead: ({ organizationId, source }) =>
				source.kind !== "tool"
					? Effect.succeed(true)
					: settings.organization(organizationId).pipe(
							Effect.map((current) =>
								Arr.some(
									current.document.appReadRules,
									(rule) =>
										rule.cardUrl === source.cardUrl &&
										rule.tool === source.name,
								),
							),
							// Without the settings, a tool counts as one that changes something.
							Effect.tapCauseIf(Cause.hasFails, (cause) =>
								report("App read rules could not be read.", cause),
							),
							Effect.orElseSucceed(() => false),
						),
		})
	}),
)
