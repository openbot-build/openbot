import { Context, Layer } from "effect"
import type { AppExecution } from "@openbot-build/api"

export interface ReadRule {
	readonly cardUrl: string
	readonly tool: string
}
/** Only the deployment owner says which actions only read. App annotations never do. */
export class ActionPolicy extends Context.Service<
	ActionPolicy,
	{
		readonly isRead: (source: AppExecution.Source) => boolean
	}
>()("@openbot-build/openbot/apps/ActionPolicy") {}

export const layer = (rules: ReadonlyArray<ReadRule> = []) =>
	Layer.succeed(ActionPolicy, {
		isRead: (source) =>
			source.kind !== "tool" ||
			rules.some(
				(rule) => rule.cardUrl === source.cardUrl && rule.tool === source.name,
			),
	})
