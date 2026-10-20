import { Array as EffectArray, Match, Effect } from "effect"
import { ContextCompaction, ContextWindow } from "@openbot-build/core"
import { Prompt } from "effect/ai"
export const ContextCompactionTest = (
	options: {
		before?: number
		after?: number
		compact?: (
			request: ContextCompaction.Request,
		) => Effect.Effect<
			ContextWindow.Window,
			ContextCompaction.ContextCompactionError
		>
	} = {},
) => {
	let requests: ReadonlyArray<ContextCompaction.Request> = []
	let compactions = 0
	const service: typeof ContextCompaction.ContextCompaction.Service = {
		count: (request) =>
			Effect.sync(() => {
				requests = EffectArray.append(requests, request)
				return Match.value(request.window).pipe(
					Match.tag("Native", () => options.after ?? 10),
					Match.orElse(() => options.before ?? 90),
				)
			}),
		compact: (request) => {
			compactions++
			return (
				options.compact?.(request) ??
				Effect.succeed({
					_tag: "Native",
					provider: request.selection.provider,
					model: request.selection.model,
					items: [
						{
							type: "message",
							content: [{ type: "output_text", text: "retained" }],
						},
						{
							type: "compaction",
							encrypted_content: "encrypted",
							opaque: { v: 1 },
						},
					],
					prompt: Prompt.empty,
				})
			)
		},
	}
	return {
		service,
		get requests() {
			return requests
		},
		get compactions() {
			return compactions
		},
	}
}
