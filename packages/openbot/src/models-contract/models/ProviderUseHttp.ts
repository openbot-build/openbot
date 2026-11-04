import { Provider } from "@openbot-build/core"
import { ModelProvidersApi } from "@openbot-build/api"
import { Effect } from "effect"
import * as Failures from "../../server-kernel/errors/Failures.ts"
import { Settings } from "../../server-kernel/settings/Settings.ts"

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
						ModelProvidersApi.ModelProvidersUnavailable.make({}),
					),
				)
			if (
				current.document.rulesModel?.provider === input.providerId ||
				current.document.botMemoryModel?.provider === input.providerId
			)
				return yield* ModelProvidersApi.ModelProviderInUse.make({
					providerId: Provider.Id.make(input.providerId),
				})
		}
	})
