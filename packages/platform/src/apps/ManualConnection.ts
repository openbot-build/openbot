import { ConnectionsApi as Api } from "@openbot-build/platform-api"
import { Document, Store } from "@openbot-build/protocol"
import { Effect, Redacted, Record } from "effect"

/** Build a private declaration. Do not present it as publisher discovery. */
export const configure =
	(owner: string) =>
	(
		input: Api.ManualConnectionRequest,
	): Effect.Effect<
		{
			readonly app: Store.AppRecord
			readonly connection: Store.UserConnection
		},
		Api.ConnectionConfigurationInvalid
	> =>
		Effect.gen(function* () {
			const card = yield* Document.ServerCard.decode({
				$schema: Document.cardSchemaUrl,
				name: `manual/${input.id}`,
				title: input.name.trim(),
				version: "1.0.0",
				description: "Manually configured MCP service",
				remotes: [
					{
						type: input.transport,
						url: input.url,
						headers: Record.keys(input.headers).map((name) => ({
							name,
							isSecret: true,
							isRequired: true,
						})),
						supportedProtocolVersions: [Document.protocolVersion],
					},
				],
			}).pipe(
				Effect.mapError(() =>
					Api.ConnectionConfigurationInvalid.make({
						keys: [],
						message: "The manual MCP configuration is invalid.",
					}),
				),
			)
			const cardUrl = `urn:openbot:manual:${input.id}`
			return {
				app: { cardUrl, card, sources: [{ role: "manual", url: input.url }] },
				connection: {
					owner,
					connectionId: input.id,
					cardUrl,
					endpoint: input.url,
					remoteIndex: 0,
					configuration: Redacted.make(
						Record.fromEntries(
							Record.toEntries(input.headers).map(([name, value]) => [
								`header:${name}`,
								value,
							]),
						),
					),
					headers: Redacted.make(input.headers),
					state: "Enabled",
					authorization: { _tag: "Unprotected" },
				},
			}
		})
