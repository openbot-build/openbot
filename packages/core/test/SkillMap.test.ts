import { Chunk, Effect } from "effect"
import { Skill, SkillMap } from "@openbot-build/core"
import { assert, it } from "@effect/vitest"

it.effect(
	"SkillMap merges in argument order, and a later definition replaces one with the same name",
	() => {
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
		return Effect.gen(function* () {
			const catalog = yield* Effect.gen(function* () {
				const service = yield* SkillMap.SkillMap
				assert.deepStrictEqual(Chunk.toReadonlyArray(service.skills), [
					last,
					other,
				])
				return service.merge(two, one)
			}).pipe(Effect.provide(SkillMap.layer(one, two)))
			assert.deepStrictEqual(Chunk.toReadonlyArray(catalog), [first, other])
			assert.deepStrictEqual(Chunk.toReadonlyArray(one), [first])
		})
	},
)
