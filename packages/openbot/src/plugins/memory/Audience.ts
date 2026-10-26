import { Array as Arr, Equal, Match, Option, pipe, String as Str } from "effect"

/**
 * The tags that OpenBot sets on Bot memory entries. A tag with a colon belongs to OpenBot.
 * The memory Bot never writes them itself, so the model cannot change who sees an entry.
 *
 * - `from:<userId>`: a person who said or did what the entry is about.
 * - `for:person:<userId>`, `for:channel:<channelId>`, `for:bot`: who may see the entry.
 * - `chat:<id>`, `channel:<id>`: where the entry comes from.
 * - `org:<organizationId>`: the organization where it happened. Only work in that
 *   organization sees the entry.
 * - `app:<tool>`: a tool result from an App supports the entry.
 */

/** Who may see an entry: one person, the people of one Channel group, or everyone who uses the Bot. */
export type Audience =
	| { readonly _tag: "Person"; readonly id: string }
	| { readonly _tag: "Channel"; readonly id: string }
	| { readonly _tag: "Bot" }

export const person = (id: string): Audience => ({ _tag: "Person", id })
export const channel = (id: string): Audience => ({ _tag: "Channel", id })
export const everyone: Audience = { _tag: "Bot" }

export const fromTag = (userId: string) => "from:" + userId
export const chatTag = (chat: string) => "chat:" + chat
export const orgTag = (organizationId: string) => "org:" + organizationId
export const channelTag = (channelId: string) => "channel:" + channelId
export const appTag = (tool: string) => "app:" + tool
export const forTag = (audience: Audience) =>
	Match.valueTags(audience, {
		Bot: () => "for:bot",
		Person: ({ id }) => "for:person:" + id,
		Channel: ({ id }) => "for:channel:" + id,
	})

/** A tag of OpenBot. Topic tags have no colon. */
export const isSystem = (tag: string) => Str.includes(":")(tag)

const valuesOf = (tags: ReadonlyArray<string>, prefix: string) =>
	pipe(
		tags,
		Arr.filter(Str.startsWith(prefix)),
		Arr.map(Str.slice(prefix.length)),
	)

/** Reads an audience in the form of a `for:` tag without its prefix: `bot`, `person:<id>` or `channel:<id>`. */
export const parseAudience = (text: string): Option.Option<Audience> =>
	text === "bot"
		? Option.some(everyone)
		: Str.startsWith("person:")(text) && text.length > "person:".length
			? Option.some(person(Str.slice("person:".length)(text)))
			: Str.startsWith("channel:")(text) && text.length > "channel:".length
				? Option.some(channel(Str.slice("channel:".length)(text)))
				: Option.none()

export const audiencesOf = (tags: ReadonlyArray<string>) =>
	Arr.flatMap(tags, (tag) =>
		Str.startsWith("for:")(tag)
			? Option.toArray(parseAudience(Str.slice("for:".length)(tag)))
			: [],
	)
export const peopleOf = (tags: ReadonlyArray<string>) => valuesOf(tags, "from:")
export const orgsOf = (tags: ReadonlyArray<string>) => valuesOf(tags, "org:")

/**
 * The people who may see both of two entries. `for:bot` is everyone, so it gives the other side.
 * Two different people, or a person and a Channel, give nobody: OpenBot does not know who is
 * in a Channel group, so it does not guess.
 */
export const intersect = (
	a: ReadonlyArray<Audience>,
	b: ReadonlyArray<Audience>,
): ReadonlyArray<Audience> =>
	// Audiences hold only plain data, so Effect compares them by value.
	Arr.dedupe(
		Arr.flatMap(a, (left) =>
			Arr.flatMap(b, (right): ReadonlyArray<Audience> =>
				left._tag === "Bot"
					? [right]
					: right._tag === "Bot" || Equal.equals(left, right)
						? [left]
						: [],
			),
		),
	)

/**
 * The system tags of an entry that other entries support: it comes from all of their people
 * and places, but only the people who may see every one of them may see it.
 */
export const combine = (
	supports: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<string> => {
	if (supports.length === 0) return []
	const union = Arr.dedupe(
		Arr.flatMap(supports, (tags) =>
			Arr.filter(
				tags,
				(tag) =>
					Str.startsWith("from:")(tag) ||
					Str.startsWith("chat:")(tag) ||
					Str.startsWith("channel:")(tag) ||
					Str.startsWith("app:")(tag),
			),
		),
	)
	const [firstOrgs = [], ...otherOrgs] = Arr.map(supports, orgsOf)
	const orgs = Arr.reduce(otherOrgs, firstOrgs, (left, right) =>
		Arr.intersection(left, right),
	)
	const [firstAudiences = [], ...otherAudiences] = Arr.map(
		supports,
		audiencesOf,
	)
	const audiences = Arr.reduce(otherAudiences, firstAudiences, intersect)
	return [...union, ...Arr.map(orgs, orgTag), ...Arr.map(audiences, forTag)]
}

/**
 * Who looks at memory.
 * - In a Turn with one person, `person` is that person.
 * - In a Channel group, `channel` is the Channel and `person` is missing, because the
 *   whole group reads the answer.
 * - A person who reads memory with the API has `person` only.
 */
export interface Viewer {
	readonly organizationId: string
	readonly person?: string
	readonly channel?: string
}

/**
 * Whether a viewer may see an entry with these tags. An entry without a `for:` tag is for
 * nobody. A person sees a Channel entry outside the group only when they took part in it.
 */
export const visible = (tags: ReadonlyArray<string>, viewer: Viewer) =>
	orgsOf(tags).includes(viewer.organizationId) &&
	Arr.some(audiencesOf(tags), (audience) =>
		Match.valueTags(audience, {
			Bot: () => true,
			Person: ({ id }) => viewer.channel === undefined && viewer.person === id,
			Channel: ({ id }) =>
				viewer.channel === id ||
				(viewer.channel === undefined &&
					viewer.person !== undefined &&
					peopleOf(tags).includes(viewer.person)),
		}),
	)
