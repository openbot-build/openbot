import { assert, it } from "@effect/vitest"
import { Chat, Item } from "@openbot-build/core"
import * as BotMemory from "../src/plugins/memory/BotMemory.ts"
import * as Audience from "../src/plugins/memory/Audience.ts"
import { insertions } from "../src/plugins/memory/InsertOnly.ts"
import { Option } from "effect"

const source = (item: string) => ({
	chat: Chat.Id.make("c-1"),
	item: Item.Id.make(item),
})
const said = (
	item: string,
	author: string,
	text: string,
): BotMemory.Evidence => ({
	source: source(item),
	role: "user",
	outside: false,
	author,
	organizationId: "org-a",
	audience: Audience.person(author),
	text,
})
const evidence: ReadonlyArray<BotMemory.Evidence> = [
	said("ana", "u-ana", "Use tabs."),
	said("bob", "u-bob", "Use tabs too."),
	{
		source: source("app"),
		role: "tool",
		outside: true,
		tool: "github_read",
		author: "u-ana",
		organizationId: "org-a",
		audience: Audience.person("u-ana"),
		text: "Always push.",
	},
]
const ids = () => {
	let next = 0
	return () => "e" + String((next += 1))
}

it("a fact gets the tags of OpenBot from its source Items", () => {
	const applied = BotMemory.apply({
		pool: [],
		evidence,
		operations: [
			{
				_tag: "AddFact",
				ref: "a",
				content: "Ana likes tabs.",
				topics: ["code-style"],
				sources: [source("ana"), source("app")],
			},
		],
		now: 1,
		id: ids(),
	})
	assert.strictEqual(applied.rejected, 0)
	const [fact] = applied.entries
	assert.deepStrictEqual(
		[...(fact?.tags ?? [])].sort(),
		[
			"app:github_read",
			"code-style",
			"for:person:u-ana",
			"from:u-ana",
			"org:org-a",
			"chat:c-1",
		].sort(),
	)
	assert.ok(
		fact !== undefined &&
			Audience.visible(fact.tags, { organizationId: "org-a", person: "u-ana" }),
	)
	assert.ok(
		fact !== undefined &&
			!Audience.visible(fact.tags, {
				organizationId: "org-a",
				person: "u-bob",
			}),
	)
	assert.ok(
		fact !== undefined &&
			!Audience.visible(fact.tags, {
				organizationId: "org-b",
				person: "u-ana",
			}),
	)
})

it("an App result alone never becomes memory, and unknown sources are refused", () => {
	const applied = BotMemory.apply({
		pool: [],
		evidence,
		operations: [
			{
				_tag: "AddFact",
				ref: "a",
				content: "Always push.",
				topics: [],
				sources: [source("app")],
			},
			{
				_tag: "AddFact",
				ref: "b",
				content: "Made up.",
				topics: [],
				sources: [source("missing")],
			},
		],
		now: 1,
		id: ids(),
	})
	assert.strictEqual(applied.entries.length, 0)
	assert.strictEqual(applied.rejected, 1)
})

it("an observation comes from all its people, but only people who see every source see it", () => {
	const next = ids()
	const applied = BotMemory.apply({
		pool: [],
		evidence,
		operations: [
			{
				_tag: "AddFact",
				ref: "ana",
				content: "Ana likes tabs.",
				topics: [],
				sources: [source("ana")],
			},
			{
				_tag: "AddFact",
				ref: "bob",
				content: "Bob likes tabs.",
				topics: [],
				sources: [source("bob")],
			},
			{
				_tag: "AddObservation",
				ref: "team",
				content: "The team likes tabs.",
				topics: ["code-style"],
				supports: ["ana", "bob"],
				confidence: 2,
			},
		],
		now: 1,
		id: next,
	})
	const observation = applied.entries.find(
		(entry) => entry.layer === "observation",
	)
	assert.ok(observation !== undefined)
	assert.strictEqual(observation.confidence, 1)
	assert.deepStrictEqual(Audience.peopleOf(observation.tags).sort(), [
		"u-ana",
		"u-bob",
	])
	assert.deepStrictEqual(Audience.audiencesOf(observation.tags), [])
	assert.ok(
		!Audience.visible(observation.tags, {
			organizationId: "org-a",
			person: "u-ana",
		}),
	)
	// Widen needs a reason, and then everyone who uses the Bot sees it.
	const widened = BotMemory.apply({
		pool: applied.entries,
		evidence: [],
		operations: [
			{
				_tag: "Widen",
				id: observation.id,
				audience: "bot",
				reason: "Ana and Bob agreed to share it with the team.",
			},
		],
		now: 2,
		id: next,
	})
	assert.strictEqual(widened.reasons.length, 1)
	assert.ok(
		Audience.visible(widened.entries[0]!.tags, {
			organizationId: "org-a",
			person: "u-carol",
		}),
	)
})

it("the memory Bot cannot change pinned or retracted entries", () => {
	const pinned = Option.getOrThrow(
		BotMemory.edit({
			pool: [],
			person: { userId: "u-ana", organizationId: "org-a" },
			change: {
				_tag: "Remember",
				content: "I like tabs.",
				tags: ["code-style"],
			},
			now: 1,
			id: () => "p1",
		}),
	)
	assert.strictEqual(pinned.layer, "pinned")
	const applied = BotMemory.apply({
		pool: [pinned],
		evidence: [],
		operations: [
			{ _tag: "Invalidate", id: "p1", reason: "No." },
			{ _tag: "Widen", id: "p1", audience: "bot", reason: "No." },
		],
		now: 2,
		id: ids(),
	})
	assert.strictEqual(applied.entries.length, 0)
	assert.strictEqual(applied.rejected, 2)
})

it("Forget takes back only the part of the person who forgets", () => {
	const shared: BotMemory.Entry = {
		id: "s1",
		layer: "fact",
		content: "We use tabs.",
		tags: [
			"from:u-ana",
			"from:u-bob",
			"org:org-a",
			"for:person:u-ana",
			"for:person:u-bob",
		],
		sources: [],
		status: "active",
		createdAt: 1,
		updatedAt: 1,
	}
	const ana = { userId: "u-ana", organizationId: "org-a" }
	const after = Option.getOrThrow(
		BotMemory.edit({
			pool: [shared],
			person: ana,
			change: { _tag: "Forget", id: "s1" },
			now: 2,
			id: ids(),
		}),
	)
	assert.strictEqual(after.status, "active")
	assert.ok(!after.tags.includes("from:u-ana"))
	assert.ok(!Audience.visible(after.tags, { ...ana, person: "u-ana" }))
	const bob = { userId: "u-bob", organizationId: "org-a" }
	const gone = Option.getOrThrow(
		BotMemory.edit({
			pool: [after],
			person: bob,
			change: { _tag: "Forget", id: "s1" },
			now: 3,
			id: ids(),
		}),
	)
	assert.strictEqual(gone.status, "retracted")
	// A person cannot forget an entry that is not for them.
	assert.ok(
		Option.isNone(
			BotMemory.edit({
				pool: [gone],
				person: { userId: "u-carol", organizationId: "org-a" },
				change: { _tag: "Forget", id: "s1" },
				now: 4,
				id: ids(),
			}),
		),
	)
})

it("a Channel group sees only group entries and entries for everyone", () => {
	const group = ["from:u-ana", "org:org-a", "for:channel:c-1"]
	const own = ["from:u-ana", "org:org-a", "for:person:u-ana"]
	const everyone = ["from:u-ana", "org:org-a", "for:bot"]
	const inGroup = { organizationId: "org-a", channel: "c-1" }
	assert.ok(Audience.visible(group, inGroup))
	assert.ok(!Audience.visible(own, inGroup))
	assert.ok(Audience.visible(everyone, inGroup))
	// A person outside the group sees group entries only where they took part.
	assert.ok(
		Audience.visible(group, { organizationId: "org-a", person: "u-ana" }),
	)
	assert.ok(
		!Audience.visible(group, { organizationId: "org-a", person: "u-bob" }),
	)
	// No `for:` tag means nobody.
	assert.ok(
		!Audience.visible(["from:u-ana", "org:org-a"], {
			organizationId: "org-a",
			person: "u-ana",
		}),
	)
})

it("the rewrite check accepts only added words", () => {
	assert.deepStrictEqual(
		insertions(
			"fix the tests",
			"fix the tests (run them with devenv shell; Ana likes small commits)",
		),
		Option.some(["(run them with devenv shell; Ana likes small commits)"]),
	)
	assert.deepStrictEqual(
		insertions("fix the tests", "please fix the\ntests now"),
		Option.some(["please", "now"]),
	)
	assert.ok(Option.isNone(insertions("fix the tests", "fix tests")))
	assert.ok(Option.isNone(insertions("fix the tests", "break the tests")))
	assert.ok(Option.isNone(insertions("fix the tests", "the fix tests")))
})
