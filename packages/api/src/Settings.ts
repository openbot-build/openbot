import { SettingsUnavailable } from "@openbot-build/domain/SettingsErrors"
import { HttpApiSchema } from "effect/http-api"
import {
	SettingsConflict,
	SettingsInvalid,
} from "@openbot-build/domain/Settings"
export const SettingsErrors = [
	SettingsConflict.pipe(HttpApiSchema.status(409)),
	SettingsInvalid.pipe(HttpApiSchema.status(400)),
	SettingsUnavailable.pipe(HttpApiSchema.status(503)),
] as const
