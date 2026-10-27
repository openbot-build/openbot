import { type Bot, ToolRegistration } from "@openbot-build/core"
import { Array as Arr, Context, Record as Rec } from "effect"
import { Tool } from "effect/ai"
import { PlanAllowed, ReviewAllowed } from "./ToolEntry.ts"

/** Combine definitions and hooks. No feature owns another feature's event stream. */
export const merge = (
	parts: ReadonlyArray<Bot.ToolRegistration>,
): Bot.ToolRegistration =>
	Arr.reduce(
		parts,
		{ tools: {}, handlers: Context.empty() },
		ToolRegistration.merge,
	)

/** Apply the same tool rules after all features have registered. */
export const select = (
	registration: Bot.ToolRegistration,
	policy: { readonly review: boolean; readonly plan: boolean },
): Bot.ToolRegistration => {
	const tools: Readonly<Record<string, Tool.Any>> = registration.tools
	return {
		...registration,
		tools: Rec.filter(tools, (tool) =>
			policy.review
				? Context.get(tool.annotations, ReviewAllowed)
				: !policy.plan ||
					Context.get(tool.annotations, Tool.Readonly) ||
					Context.get(tool.annotations, PlanAllowed),
		),
	}
}
