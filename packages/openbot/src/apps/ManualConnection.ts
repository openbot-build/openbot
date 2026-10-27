import { AppConnections as Domain } from "@openbot-build/domain"

import { Discovery, Document, Store } from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Redacted,
	Record as Rec,
	String as Str,
} from "effect"

/** Build a private declaration. Do not present it as publisher discovery. */
export const configure =
	(owner: string) =>
	(
		input: Domain.ManualConnectionRequest,
	): Effect.Effect<
		{
			readonly app: Store.AppRecord
			readonly connection: Store.UserConnection
		},
		Domain.ConnectionConfigurationInvalid
	> =>
		Effect.gen(function* () {
			const card = yield* Document.ServerCard.decode({
				$schema: Document.cardSchemaUrl,
				name: `manual/${input.id}`,
				title: Str.trim(input.name),
				version: "1.0.0",
				description: "Manually configured MCP service",
				remotes: [
					{
						type: input.transport,
						url: input.url,
						headers: Arr.map(Rec.keys(input.headers), (name) => ({
							name,
							isSecret: true,
							isRequired: true,
						})),
						supportedProtocolVersions: [Document.protocolVersion],
					},
				],
			}).pipe(
				Effect.catchTag("InvalidDocument", () =>
					Effect.fail(
						Domain.ConnectionConfigurationInvalid.make({
							keys: [],
							message: "The manual MCP configuration is invalid.",
						}),
					),
				),
			)
			const cardUrl = `urn:openbot:manual:${input.id}`
			return {
				app: Store.AppRecord.make({
					cardUrl,
					card,
					sources: [Discovery.Source.make({ role: "manual", url: input.url })],
				}),
				connection: Store.UserConnection.make({
					owner,
					connectionId: input.id,
					cardUrl,
					endpoint: input.url,
					remoteIndex: 0,
					configuration: Redacted.make(
						Rec.mapKeys(input.headers, (name) => `header:${name}`),
					),
					headers: Redacted.make(input.headers),
					state: "Enabled",
					authorization: { _tag: "Unprotected" },
				}),
			}
		})
