import { ConnectionsApi as Api } from "@openbot-build/api"
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
						// A manual address has no declared version. The SDK negotiates it.
					},
				],
			}).pipe(
				Effect.catchTag("InvalidDocument", () =>
					Effect.fail(
						Api.ConnectionConfigurationInvalid.make({
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

/** Prepare only. Import must not call the service or copy secret values. */
export const draft = (
	owner: string,
	input: {
		readonly id: string
		readonly name: string
		readonly manual: Api.ManualTransfer
		readonly expiresAt: number
	},
) =>
	Effect.gen(function* () {
		const headers = Rec.fromEntries(
			Arr.map(input.manual.headers, (name) => [name, ""] as const),
		)
		const configured = yield* configure(owner)({
			id: Api.ConnectionId.make(input.id),
			name: input.name,
			url: input.manual.url,
			transport: input.manual.transport,
			headers,
		})
		const remote = configured.app.card.remotes?.[0]
		if (remote === undefined)
			return yield* Api.ConnectionConfigurationInvalid.make({
				keys: [],
				message: "The manual address has no endpoint.",
			})
		const result: Api.ConnectionDraft = {
			id: input.id,
			revision: 0,
			input: input.manual.url,
			expiresAt: input.expiresAt,
			imported: { name: input.name, remoteIndex: 0 },
			manual: input.manual,
			discovery: {
				_tag: "Single",
				issues: [],
				candidate: Discovery.Candidate.make({
					...configured.app,
					endpoints: [
						Discovery.Endpoint.make({
							index: 0,
							remote,
							requirements: Arr.map(input.manual.headers, (name) =>
								Discovery.ConfigurationRequirement.make({
									key: "header:" + name,
									isSecret: true,
								}),
							),
						}),
					],
				}),
			},
		}
		return result
	})
