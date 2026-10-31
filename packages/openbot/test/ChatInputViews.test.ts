import { assert, it } from "@effect/vitest"
import { Chat, ChatState, Item, Turn } from "@openbot-build/core"
import { Prompt } from "effect/ai"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as ChatViews from "../src/chats/ChatViews.ts"
import * as BotFixture from "./BotFixture.ts"

it("the public queue keeps person input IDs and leaves out notices and actions", () => {
	const input = (
		id: string,
		kind: "message" | "steer" | "action",
	): Chat.InboxEntry => ({
		id: Item.Id.make(id),
		kind,
		turn: Turn.Id.make("waiting-turn"),
		content: Prompt.make("Same words."),
	})
	const chat: Chat.Ref = {
		id: Chat.Id.make("queue-chat"),
		revision: Chat.Revision.make(1),
		settings: { mode: "build" },
		inbox: [
			input("person-message", "message"),
			input("person-steer", "steer"),
			{ ...input("notice", "message"), notice: { kind: "work" } },
			{
				...input("approval", "steer"),
				approved: { id: "call", name: "write", params: {} },
			},
			input("action", "action"),
			{
				...input("message-action", "message"),
				action: { name: "write", arguments: {} },
			},
		],
		seq: Item.Seq.make(0),
		business: {
			[ChatHost.chatHostId]: { ...BotFixture.direct(), bot: BotFixture.bot.id },
		},
		createdAt: 0,
	}
	const view = ChatViews.project({
		view: { chat, state: ChatState.initial<ChatHost.Values>({}) },
		items: [],
		executionId: null,
		open: { delegations: 0, requests: 0, reminders: 0 },
	})
	assert.strictEqual(view.inbox, 6)
	assert.deepStrictEqual(view.queuedInputs, [
		{
			id: Item.Id.make("person-message"),
			kind: "message",
			turn: Turn.Id.make("waiting-turn"),
			content: Prompt.make("Same words."),
		},
		{
			id: Item.Id.make("person-steer"),
			kind: "steer",
			turn: Turn.Id.make("waiting-turn"),
			content: Prompt.make("Same words."),
		},
	])
})
