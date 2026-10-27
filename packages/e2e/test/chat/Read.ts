import { ChatResponse } from "@openbot-build/api"
import { Item, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Caller, type Messages } from "@openbot-build/openbot/testing"
import { Array as Arr, Effect, Schema, String as Str } from "effect"

const TurnState = Schema.Struct({ id: Turn.Id, status: Turn.StatusSchema })

/** Reads saved Turns through the same route as an API client. */
export const turns = (send: Messages.Send, chat: string) =>
	Caller.read(
		Schema.Struct({
			items: Schema.Array(TurnState),
			next: Schema.NullOr(Turn.Id),
		}),
		send(`/v1/chats/${chat}/turns`, "GET"),
	)

/** Reads the saved output of one Turn. */
export const turn = (send: Messages.Send, chat: string, turn: string) =>
	Caller.read(
		Schema.Struct({ turn: TurnState, response: ChatResponse }),
		send(`/v1/chats/${chat}/turns/${turn}`, "GET"),
	)

/** Reads the full public history used by the test. */
export const items = (send: Messages.Send, chat: string) =>
	Caller.read(
		Schema.Struct({
			items: Schema.Array(Item.Record),
			next: Schema.NullOr(Item.Seq),
		}),
		send(`/v1/chats/${chat}/items?limit=100`, "GET"),
	)

/** Reads an execution event stream until the server sends its end. */
export const observe = (
	send: Messages.Send,
	execution: string,
	afterSequence = 0,
) =>
	Effect.gen(function* () {
		const response = yield* send(
			`/v1/executions/${execution}/observe?afterSequence=${afterSequence}`,
			"GET",
		)
		if (response.status !== 200)
			return yield* Effect.die(`The event stream returned ${response.status}.`)
		const frames = Str.split(yield* response.text, /\r?\n\r?\n/)
		return yield* Effect.forEach(
			Arr.flatMap(frames, (frame) =>
				Arr.filter(Str.split(frame, /\r?\n/), (line) =>
					Str.startsWith("data:")(line),
				),
			),
			(line) =>
				Schema.decodeEffect(Schema.fromJsonString(Execution.Event))(
					Str.trim(Str.slice(5)(line)),
				),
		)
	})
