import { HttpApiSchema } from "effect/http-api"
import {
	ExperienceInputInvalid,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/domain"
export {
	ExperienceInputInvalid,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/domain"
export const ExperienceErrors = [
	ExperienceInputInvalid.pipe(HttpApiSchema.status(400)),
	ExperienceNotFound.pipe(HttpApiSchema.status(404)),
	ExperienceStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
