import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import { Authorize, GroupRequired, requires } from "./Permissions.ts"
import {
	MemberSettings,
	SettingsErrors,
	UpdateMemberSettingsRequest,
} from "./Settings.ts"

/** The settings of the caller in its organization. Each member has their own. */
export class MemberSettingsApi extends HttpApiGroup.make("memberSettings")
	.add(
		HttpApiEndpoint.get("getMemberSettings", "/v1/me/settings", {
			success: MemberSettings,
			error: SettingsErrors,
		}),
		HttpApiEndpoint.patch("updateMemberSettings", "/v1/me/settings", {
			payload: UpdateMemberSettingsRequest,
			success: MemberSettings,
			error: SettingsErrors,
		}).annotate(
			OpenApi.Description,
			"Changes your settings. Send the `version` that you read as `expectedVersion`. If they changed since then, the change fails with SettingsConflict.",
		),
	)
	.annotate(GroupRequired, {
		read: [requires("chats.read").on("user")],
		write: [requires("chats.write").on("user")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
