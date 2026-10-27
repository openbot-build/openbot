import { assert, describe, it } from "@effect/vitest"
import { Chat, Item, Turn } from "@openbot-build/core"
import { Bots, type ExecutionIdentity } from "@openbot-build/domain"
import { HashSet } from "effect"
import { Prompt } from "effect/ai"
import * as Evidence from "../src/bots/MemoryEvidence.ts"
import { chatHostId } from "../src/chats/ChatHost.ts"

const identity: ExecutionIdentity = {
	owner: { organizationId: "org", userId: "owner" },
	actor: { kind: "member", organizationId: "org", userId: "alice#work" },
}
const chat: Chat.Ref = {
	id: Chat.Id.make("chat"),
	revision: Chat.Revision.make(1),
	seq: Item.Seq.make(1),
	settings: { mode: "build" },
	inbox: [],
	createdAt: 0,
	business: {
		[chatHostId]: {
			bot: Bots.BotId.make("bot"),
			kind: "direct",
			chain: { organizationId: "org", userId: "owner", bots: [], chats: [] },
		},
	},
}
const item: Item.Record = {
	id: Item.Id.make("item"),
	seq: Item.Seq.make(1),
	content: Prompt.make([{ role: "user", content: "I like green tea." }]),
	origin: { chat: chat.id, turn: Turn.Id.make("opaque-turn"), step: 0 },
}
describe("Memory evidence", () => {
	it("uses the saved actor without reading a Turn author or splitting the user ID", () => {
		const evidence = Evidence.evidence(chat, item, identity, HashSet.empty())
		assert.strictEqual(evidence[0]?.author, "alice#work")
		assert.deepStrictEqual(evidence[0]?.audience, {
			_tag: "Person",
			id: "alice#work",
		})
		assert.deepStrictEqual(Evidence.viewer(chat, identity), {
			organizationId: "org",
			person: "alice#work",
		})
	})
	it("does not learn from a system notice", () => {
		assert.deepStrictEqual(
			Evidence.evidence(
				chat,
				{
					...item,
					origin: {
						chat: chat.id,
						turn: Turn.Id.make("opaque-turn"),
						step: 0,
						notice: { kind: "reminder", ref: "reminder" },
					},
				},
				identity,
				HashSet.empty(),
			),
			[],
		)
	})
})
