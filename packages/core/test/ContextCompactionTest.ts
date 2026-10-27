import { Array as Arr, Effect, Match, Ref } from "effect"
import { ContextCompaction, ContextWindow } from "@openbot-build/core"
import { Prompt } from "effect/ai"

/**
 * A fake ContextCompaction service. It keeps every count request, and it counts
 * each run of a compact Effect, so a test can see a repeat.
 */
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
) =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<ReadonlyArray<ContextCompaction.Request>>(
			[],
		)
		const compactions = yield* Ref.make(0)
		const service: typeof ContextCompaction.ContextCompaction.Service = {
			count: (request) =>
				Ref.update(requests, Arr.append(request)).pipe(
					Effect.as(
						Match.value(request.window).pipe(
							Match.tag("Native", () => options.after ?? 10),
							Match.orElse(() => options.before ?? 90),
						),
					),
				),
			compact: (request) =>
				Ref.update(compactions, (n) => n + 1).pipe(
					Effect.andThen(
						options.compact?.(request) ??
							Effect.succeed<ContextWindow.Window>({
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
							}),
					),
				),
		}
		return {
			service,
			requests: Ref.get(requests),
			compactions: Ref.get(compactions),
		}
	})
