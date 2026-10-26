import {
	Array as Arr,
	Chunk,
	Context,
	HashMap,
	Layer,
	Option,
	pipe,
} from "effect"
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

/** A skill keeps the position of its first definition and the value of its last one. */
const merge = (...maps: ReadonlyArray<Catalog>): Catalog => {
	const skills = Arr.flatMap(maps, Chunk.toReadonlyArray)
	const latest = HashMap.fromIterable(
		Arr.map(skills, (skill) => [skill.id, skill] as const),
	)
	return pipe(
		skills,
		Arr.dedupeWith((left, right) => left.id === right.id),
		Arr.map((skill) =>
			Option.getOrElse(HashMap.get(latest, skill.id), () => skill),
		),
		Chunk.fromIterable,
	)
}

export const make = (
	...maps: ReadonlyArray<Catalog>
): typeof SkillMap.Service => ({
	skills: merge(...maps),
	merge,
})
export const layer = (...maps: ReadonlyArray<Catalog>) =>
	Layer.succeed(SkillMap, make(...maps))
