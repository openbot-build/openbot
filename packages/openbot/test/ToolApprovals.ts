import { Chat } from "@openbot-build/core"
import { Effect, HashMap, Layer, Ref } from "effect"
import * as Approvals from "../src/capabilities/Approvals.ts"
import { Answer, Gate, type Attempt } from "../src/capabilities/Gate.ts"

/** Plugin tests keep answers in one explicit Gate. Database replay has its own tests. */
export const layer = (check: (attempt: Attempt) => Effect.Effect<Answer>) => {
	const gate = Layer.effect(
		Gate,
		Effect.gen(function* () {
			const answers = yield* Ref.make(HashMap.empty<string, Answer>())
			const remember: typeof Gate.Service.remember = (id, answer) =>
				Ref.update(answers, HashMap.set(id, answer))
			return Gate.of({
				check: (attempt) =>
					check(attempt).pipe(
						Effect.tap((answer) => remember(attempt.site.main, answer)),
					),
				remember,
				answer: (id) => Ref.get(answers).pipe(Effect.map(HashMap.get(id))),
			})
		}),
	)
	return Layer.effect(Chat.Approvals, Effect.map(Gate, Approvals.durable)).pipe(
		Layer.provideMerge(gate),
	)
}
