import { Data, Schema } from "effect"

export const Id = Schema.String.pipe(
	Schema.brand("@openbot-build/core/SkillId"),
)
export type Id = typeof Id.Type

export class Descriptor extends Data.TaggedClass("Skill.Descriptor")<{
	readonly id: Id
	readonly name: string
	readonly description: string
	readonly source: string
}> {}

export class Loaded extends Data.TaggedClass("Skill.Loaded")<{
	readonly skill: Descriptor
	readonly instructions: string
}> {}
