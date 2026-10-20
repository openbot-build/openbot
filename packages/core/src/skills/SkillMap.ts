import { Chunk, HashMap, Option, Context, Layer } from "effect"
import type * as Skill from "./Skill.ts"

export type Catalog = Chunk.Chunk<Skill.Descriptor>

/** The host provides the catalog and its merge operation. */
export class SkillMap extends Context.Service<
	SkillMap,
	{
		readonly skills: Catalog
		readonly merge: (...maps: ReadonlyArray<Catalog>) => Catalog
	}
>()("@openbot-build/core/skills/SkillMap") {}

const merge = (...maps: ReadonlyArray<Catalog>): Catalog => {
	let positions = HashMap.empty<Skill.Id, number>()
	let catalog = Chunk.empty<Skill.Descriptor>()
	for (const map of maps)
		for (const skill of map) {
			const index = HashMap.get(positions, skill.id)
			if (Option.isSome(index))
				catalog = Option.getOrThrow(Chunk.replace(catalog, index.value, skill))
			else {
				positions = HashMap.set(positions, skill.id, catalog.length)
				catalog = Chunk.append(catalog, skill)
			}
		}
	return catalog
}

export const make = (
	...maps: ReadonlyArray<Catalog>
): typeof SkillMap.Service => ({
	skills: merge(...maps),
	merge,
})
export const layer = (...maps: ReadonlyArray<Catalog>) =>
	Layer.succeed(SkillMap, make(...maps))
