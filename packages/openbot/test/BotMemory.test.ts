import { assert, it } from "@effect/vitest"
import { Chat, Item } from "@openbot-build/core"
import * as BotMemory from "../src/plugins/memory/BotMemory.ts"
import * as Audience from "../src/plugins/memory/Audience.ts"
import { Array as Arr, Option } from "effect"

const changedMetadata = (result: BotMemory.Applied) =>
	Arr.map(result.changes, (change) => change.metadata)

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

it("a fact gets the tags of OpenBot from its source Items", () => {
	const applied = BotMemory.apply({
		metadata: [],
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
		ids: ["e1"],
	})
	assert.strictEqual(applied.rejected, 0)
	const [fact] = changedMetadata(applied)
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
		metadata: [],
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
		ids: ["e1", "e2"],
	})
	assert.strictEqual(changedMetadata(applied).length, 0)
	assert.strictEqual(applied.rejected, 1)
})

it("an observation comes from all its people, but only people who see every source see it", () => {
	const applied = BotMemory.apply({
		metadata: [],
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
		ids: ["e1", "e2", "e3"],
	})
	const found = Arr.findFirst(
		changedMetadata(applied),
		(entry) => entry.layer === "observation",
	)
	assert.ok(Option.isSome(found))
	const observation = found.value
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
	// A reason cannot give access to the private sources of other people.
	const widened = BotMemory.apply({
		metadata: changedMetadata(applied),
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
		ids: ["e4"],
	})
	assert.strictEqual(widened.rejected, 1)
	assert.strictEqual(widened.reasons.length, 0)
	assert.strictEqual(changedMetadata(widened).length, 0)
})

it("the memory Bot cannot change pinned or retracted entries", () => {
	const pinned = Option.getOrThrow(
		BotMemory.edit({
			metadata: [],
			person: { userId: "u-ana", organizationId: "org-a" },
			change: {
				_tag: "Remember",
				content: "I like tabs.",
				tags: ["code-style"],
			},
			now: 1,
			id: "p1",
		}),
	).metadata
	assert.strictEqual(pinned.layer, "pinned")
	const applied = BotMemory.apply({
		metadata: [pinned],
		evidence: [],
		operations: [
			{ _tag: "Invalidate", id: "p1", reason: "No." },
			{ _tag: "Widen", id: "p1", audience: "bot", reason: "No." },
		],
		now: 2,
		ids: ["e1", "e2"],
	})
	assert.strictEqual(changedMetadata(applied).length, 0)
	assert.strictEqual(applied.rejected, 2)
})

it("Forget takes back only the part of the person who forgets", () => {
	const shared: BotMemory.Metadata = {
		id: "s1",
		layer: "fact",
		tags: [
			"from:u-ana",
			"from:u-bob",
			"org:org-a",
			"for:person:u-ana",
			"for:person:u-bob",
		],
		sources: [source("shared")],
		sourcePolicies: [
			{
				source: source("shared"),
				tags: ["org:org-a", "for:bot"],
			},
		],
		status: "active",
		createdAt: 1,
		updatedAt: 1,
	}
	const ana = { userId: "u-ana", organizationId: "org-a" }
	const after = Option.getOrThrow(
		BotMemory.edit({
			metadata: [shared],
			person: ana,
			change: { _tag: "Forget", id: "s1" },
			now: 2,
			id: "unused",
		}),
	).metadata
	assert.strictEqual(after.status, "active")
	assert.ok(!after.tags.includes("from:u-ana"))
	assert.ok(!Audience.visible(after.tags, { ...ana, person: "u-ana" }))
	const bob = { userId: "u-bob", organizationId: "org-a" }
	const gone = Option.getOrThrow(
		BotMemory.edit({
			metadata: [after],
			person: bob,
			change: { _tag: "Forget", id: "s1" },
			now: 3,
			id: "unused",
		}),
	).metadata
	assert.strictEqual(gone.status, "retracted")
	// A person cannot forget an entry that is not for them.
	assert.ok(
		Option.isNone(
			BotMemory.edit({
				metadata: [gone],
				person: { userId: "u-carol", organizationId: "org-a" },
				change: { _tag: "Forget", id: "s1" },
				now: 4,
				id: "unused",
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

it("a person sees a group fact only when they may read all its sources", () => {
	const groupEvidence = Arr.map(Arr.take(evidence, 2), (entry) => ({
		...entry,
		audience: Audience.channel("c-group"),
		channel: "c-group",
	}))
	const applied = BotMemory.apply({
		metadata: [],
		evidence: groupEvidence,
		operations: [
			{
				_tag: "AddFact",
				ref: "team",
				content: "Ana and Bob like tabs.",
				topics: [],
				sources: Arr.map(groupEvidence, (entry) => entry.source),
			},
		],
		now: 1,
		ids: ["team"],
	})
	assert.strictEqual(applied.rejected, 0)
	assert.strictEqual(changedMetadata(applied).length, 1)
	const fact = changedMetadata(applied)[0]!
	assert.ok(
		BotMemory.visible(changedMetadata(applied), {
			organizationId: "org-a",
			channel: "c-group",
		})(fact),
	)
	for (const person of ["u-ana", "u-bob", "u-carol"])
		assert.ok(
			!BotMemory.visible(changedMetadata(applied), {
				organizationId: "org-a",
				person,
			})(fact),
		)
})

it("Widen can name a person who already may read every source", () => {
	const groupEvidence = Arr.map(
		["left", "right"],
		(channel): BotMemory.Evidence => ({
			...said(channel, "u-ana", "Use tea."),
			audience: Audience.channel(channel),
			channel,
		}),
	)
	const applied = BotMemory.apply({
		metadata: [],
		evidence: groupEvidence,
		now: 1,
		ids: ["left", "right", "both", "unused"],
		operations: [
			...Arr.map(groupEvidence, (entry): BotMemory.Operation => ({
				_tag: "AddFact",
				ref: entry.source.item,
				content: entry.text,
				topics: [],
				sources: [entry.source],
			})),
			{
				_tag: "AddObservation",
				ref: "both",
				content: "Tea helps.",
				topics: [],
				supports: ["left", "right"],
				confidence: 1,
			},
			{
				_tag: "Widen",
				id: "both",
				audience: "person:u-ana",
				reason: "Ana may read both sources.",
			},
		],
	})
	assert.strictEqual(applied.rejected, 0)
	assert.strictEqual(applied.reasons.length, 1)
	const observation = Option.getOrThrow(
		Arr.findFirst(changedMetadata(applied), (entry) => entry.id === "both"),
	)
	assert.ok(
		BotMemory.visible(changedMetadata(applied), {
			organizationId: "org-a",
			person: "u-ana",
		})(observation),
	)
	assert.ok(
		!BotMemory.visible(changedMetadata(applied), {
			organizationId: "org-a",
			person: "u-bob",
		})(observation),
	)
	assert.ok(
		!BotMemory.visible(changedMetadata(applied), {
			organizationId: "org-a",
			channel: "left",
		})(observation),
	)
})

it("long source chains use a work list and still check the root", () => {
	const root = Option.getOrThrow(
		BotMemory.edit({
			metadata: [],
			person: { organizationId: "org-a", userId: "u-ana" },
			change: { _tag: "Remember", content: "Use tea." },
			now: 1,
			id: "root",
		}),
	).metadata
	const entries = [
		root,
		...Arr.makeBy(12000, (index): BotMemory.Metadata => ({
			...root,
			id: "next-" + index,
			layer: "observation",
			sources: [{ entry: index === 0 ? "root" : "next-" + (index - 1) }],
		})),
	]
	const last = Option.getOrThrow(Arr.last(entries))
	assert.ok(
		BotMemory.visible(entries, { organizationId: "org-a", person: "u-ana" })(
			last,
		),
	)
	assert.ok(
		!BotMemory.visible(Arr.drop(entries, 1), {
			organizationId: "org-a",
			person: "u-ana",
		})(last),
	)
})

it("changes to old entries need no content", () => {
	const original = BotMemory.apply({
		metadata: [],
		evidence,
		operations: [
			{
				_tag: "AddFact",
				ref: "a",
				content: "Ana likes tabs.",
				topics: ["code-style"],
				sources: [source("ana")],
			},
		],
		now: 1,
		ids: ["a"],
	})
	const changed = BotMemory.apply({
		metadata: changedMetadata(original),
		evidence: [],
		operations: [
			{ _tag: "Retag", id: "a", add: ["style"], remove: ["code-style"] },
			{ _tag: "RenameTopic", from: "style", to: "tabs" },
		],
		now: 2,
		ids: ["unused-1", "unused-2"],
	})
	assert.strictEqual(changed.rejected, 0)
	assert.strictEqual(changed.changes.length, 1)
	assert.strictEqual(changed.changes[0]?.content, undefined)
	assert.deepStrictEqual(BotMemory.topicsOf(changed.changes[0]!.metadata), [
		"tabs",
	])
	const forgotten = Option.getOrThrow(
		BotMemory.edit({
			metadata: changedMetadata(changed),
			person: { organizationId: "org-a", userId: "u-ana" },
			change: { _tag: "Forget", id: "a" },
			now: 3,
			id: "unused",
		}),
	)
	assert.strictEqual(forgotten.content, undefined)
	assert.strictEqual(forgotten.metadata.status, "retracted")
})

it("later changes keep the content of a new entry in the same plan", () => {
	const applied = BotMemory.apply({
		metadata: [],
		evidence,
		operations: [
			{
				_tag: "AddFact",
				ref: "a",
				content: "Ana likes tabs.",
				topics: ["code-style"],
				sources: [source("ana")],
			},
			{ _tag: "Retag", id: "a", add: ["style"], remove: ["code-style"] },
			{ _tag: "RenameTopic", from: "style", to: "tabs" },
			{
				_tag: "Widen",
				id: "a",
				audience: "person:u-ana",
				reason: "Ana may read her words.",
			},
		],
		now: 1,
		ids: ["a-id", "unused-1", "unused-2", "unused-3"],
	})
	assert.strictEqual(applied.rejected, 0)
	assert.strictEqual(applied.changes.length, 1)
	assert.strictEqual(applied.changes[0]?.content, "Ana likes tabs.")
	assert.deepStrictEqual(BotMemory.topicsOf(applied.changes[0]!.metadata), [
		"tabs",
	])
})
