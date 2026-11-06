import {
	ModelProvidersUnavailable,
	ModelProviderInUse,
} from "@openbot-build/domain/Models"
import { Provider } from "@openbot-build/core"
import { Effect } from "effect"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { Settings } from "@openbot-build/server-kernel/Settings"

/**
 * A provider cannot go while a setting still names it, or the setting would
 * point at nothing.
 */
export const checkUnused = (
	settings: typeof Settings.Service,
	input: {
		readonly providerId: string
		readonly organizationIds: ReadonlyArray<string>
	},
) =>
	Effect.gen(function* () {
		for (const organizationId of input.organizationIds) {
			const current = yield* settings
				.organization(organizationId)
				.pipe(
					Failures.replace("Could not read the organization settings", () =>
						ModelProvidersUnavailable.make({}),
					),
				)
			if (
				current.document.rulesModel?.provider === input.providerId ||
				current.document.botMemoryModel?.provider === input.providerId
			)
				return yield* ModelProviderInUse.make({
					providerId: Provider.Id.make(input.providerId),
				})
		}
	})
