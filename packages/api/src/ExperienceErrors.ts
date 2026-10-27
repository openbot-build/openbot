import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"

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
export const ExperienceErrors = [
	ExperienceInputInvalid.pipe(HttpApiSchema.status(400)),
	ExperienceNotFound.pipe(HttpApiSchema.status(404)),
	ExperienceStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
