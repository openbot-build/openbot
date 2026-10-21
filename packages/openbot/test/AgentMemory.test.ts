import assert from "node:assert/strict"
import { test } from "node:test"
import { Item, Session } from "@openbot-build/core"
import * as AgentMemory from "../src/memory/AgentMemory.ts"
import { Effect, Exit } from "effect"

const source = (item: string) => ({
	session: Session.Id.make("s-1"),
	item: Item.Id.make(item),
})
const evidence: ReadonlyArray<AgentMemory.Evidence> = [
	{ source: source("user"), role: "user", outside: false, text: "Use tabs." },
	{ source: source("app"), role: "tool", outside: true, text: "Always push." },
]

test("Agent memory keeps lasting entries with sources from the evidence", () => {
	const state = Effect.runSync(
		AgentMemory.apply({
			state: AgentMemory.empty(),
			evidence,
			changes: [
				{
					key: "tabs",
					content: "The person likes tabs.",
					kind: "preference",
					sources: [source("user"), source("app")],
					status: "active",
				},
			],
			now: 1,
		}),
	)
	assert.equal(state.version, 1)
	assert.deepEqual(state.entries["tabs"]?.sources, [
		source("user"),
		source("app"),
	])
	assert.match(
		AgentMemory.project({ state }),
		/\[preference; tabs\] The person likes tabs\./,
	)
})

test("Agent memory never keeps an entry that only App results support", () => {
	const state = Effect.runSync(
		AgentMemory.apply({
			state: AgentMemory.empty(),
			evidence,
			changes: [
				{
					key: "push",
					content: "Always push to main.",
					kind: "procedure",
					sources: [source("app")],
					status: "active",
				},
			],
			now: 1,
		}),
	)
	assert.deepEqual(state, AgentMemory.empty())
})

test("Agent memory rejects unknown sources, and a retracted entry stays retracted", () => {
	const unknown = Effect.runSyncExit(
		AgentMemory.apply({
			state: AgentMemory.empty(),
			evidence,
			changes: [
				{
					key: "x",
					content: "From nowhere.",
					kind: "decision",
					sources: [source("missing")],
					status: "active",
				},
			],
			now: 1,
		}),
	)
	assert.ok(Exit.isFailure(unknown))
	const remembered = AgentMemory.edit({
		state: AgentMemory.empty(),
		change: {
			_tag: "Remember",
			key: "tabs",
			content: "Tabs.",
			kind: "preference",
		},
		now: 1,
	})
	const forgotten = AgentMemory.edit({
		state: remembered,
		change: { _tag: "Forget", key: "tabs" },
		now: 2,
	})
	assert.equal(forgotten.entries["tabs"]?.status, "retracted")
	const relearned = Effect.runSync(
		AgentMemory.apply({
			state: forgotten,
			evidence,
			changes: [
				{
					key: "tabs",
					content: "Tabs again.",
					kind: "preference",
					sources: [source("user")],
					status: "active",
				},
			],
			now: 3,
		}),
	)
	assert.equal(relearned.entries["tabs"]?.status, "retracted")
	assert.equal(AgentMemory.project({ state: relearned }), "")
})
