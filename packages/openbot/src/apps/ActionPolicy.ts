import { Context, Effect, Layer } from "effect"
import type { AppExecution } from "@openbot-build/api"
import { Settings } from "../settings/Settings.ts"

/**
 * Only the organization says which App tools only read, in its `appReadRules`
 * setting. App annotations never do.
 */
export class ActionPolicy extends Context.Service<
	ActionPolicy,
	{
		readonly isRead: (input: {
			readonly organizationId: string
			readonly source: AppExecution.Source
		}) => Effect.Effect<boolean>
	}
>()("@openbot-build/openbot/apps/ActionPolicy") {}

export const layer = Layer.effect(
	ActionPolicy,
	Effect.gen(function* () {
		const settings = yield* Settings
		return ActionPolicy.of({
			isRead: ({ organizationId, source }) =>
				source.kind !== "tool"
					? Effect.succeed(true)
					: settings.organization(organizationId).pipe(
							Effect.map((current) =>
								current.document.appReadRules.some(
									(rule) =>
										rule.cardUrl === source.cardUrl &&
										rule.tool === source.name,
								),
							),
							// Without the settings, a tool counts as one that changes something.
							Effect.orElseSucceed(() => false),
						),
		})
	}),
)
