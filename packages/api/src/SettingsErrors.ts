import { Schema } from "effect"

export class SettingsUnavailable extends Schema.TaggedError<
	SettingsUnavailable,
	{ readonly brand: unique symbol }
>()("SettingsUnavailable", {}) {}
