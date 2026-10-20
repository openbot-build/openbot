// Each test provides its own Layers where it runs.
// @effect-diagnostics strictEffectProvide:off

import { Option, Chunk, Effect } from "effect"
import assert from "node:assert/strict"
import { Skill, SkillMap } from "@openbot-build/core"
import { test } from "node:test"

test("SkillMap merges in argument order, and a later definition replaces one with the same name", async () => {
	const first = new Skill.Descriptor({
		id: Skill.Id.make("same"),
		name: "same",
		description: "first",
		source: "one",
	})
	const last = new Skill.Descriptor({
		...first,
		description: "last",
		source: "two",
	})
	const other = new Skill.Descriptor({
		id: Skill.Id.make("other"),
		name: "other",
		description: "other",
		source: "three",
	})
	const one: SkillMap.Catalog = Chunk.of(first)
	const two: SkillMap.Catalog = Chunk.make(last, other)
	const catalog = await Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* SkillMap.SkillMap
			assert.equal(
				Option.getOrUndefined(
					Chunk.findFirst(service.skills, (skill) => skill.id === first.id),
				),
				last,
			)
			assert.equal(
				Option.getOrUndefined(
					Chunk.findFirst(service.skills, (skill) => skill.id === other.id),
				),
				other,
			)
			return service.merge(two, one)
		}).pipe(Effect.provide(SkillMap.layer(one, two))),
	)
	assert.equal(
		Option.getOrUndefined(
			Chunk.findFirst(catalog, (skill) => skill.id === first.id),
		),
		first,
	)
	assert.equal(
		Option.getOrUndefined(
			Chunk.findFirst(catalog, (skill) => skill.id === other.id),
		),
		other,
	)
	assert.equal(
		Option.getOrUndefined(
			Chunk.findFirst(one, (skill) => skill.id === first.id),
		),
		first,
	)
})
