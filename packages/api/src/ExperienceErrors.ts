import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"

export class ExperienceNotFound extends Schema.TaggedError<ExperienceNotFound>()(
	"ExperienceNotFound",
	{ id: Schema.String },
) {}
export class ExperienceStorageUnavailable extends Schema.TaggedError<ExperienceStorageUnavailable>()(
	"ExperienceStorageUnavailable",
	{},
) {}
export class ExperienceInputInvalid extends Schema.TaggedError<ExperienceInputInvalid>()(
	"ExperienceInputInvalid",
	{ message: Schema.String },
) {}
export const ExperienceErrors = [
	ExperienceInputInvalid.pipe(HttpApiSchema.status(400)),
	ExperienceNotFound.pipe(HttpApiSchema.status(404)),
	ExperienceStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
