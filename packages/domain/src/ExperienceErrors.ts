import { Schema } from "effect"

export class ExperienceNotFound extends Schema.TaggedError<
	ExperienceNotFound,
	{ readonly brand: unique symbol }
>()("ExperienceNotFound", { id: Schema.String }) {}
export class ExperienceStorageUnavailable extends Schema.TaggedError<
	ExperienceStorageUnavailable,
	{ readonly brand: unique symbol }
>()("ExperienceStorageUnavailable", {}) {}
export class ExperienceInputInvalid extends Schema.TaggedError<
	ExperienceInputInvalid,
	{ readonly brand: unique symbol }
>()("ExperienceInputInvalid", { message: Schema.String }) {}
