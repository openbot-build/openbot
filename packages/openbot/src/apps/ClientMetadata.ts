import { Authorization } from "@openbot-build/protocol"
import { Effect } from "effect"

/** The client metadata of OpenBot for the App authorization servers. */
export const metadata = (publicOrigin: string) =>
	Authorization.ClientMetadata.decode({
		client_id: publicOrigin + "/v1/apps/client-metadata",
		client_name: "OpenBot",
		client_uri: publicOrigin,
		redirect_uris: [
			publicOrigin + "/auth/apps/callback",
			publicOrigin + "/auth/developer/apps/callback",
		],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		// The values are fixed, and the platform settings keep only valid origins, so a failure is a defect.
	}).pipe(Effect.orDie)
