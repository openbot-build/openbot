// The helpers here take plain data. A pipeable form does not help.
// @effect-diagnostics missingPipeableSignature:off
import { Array as Arr } from "effect"

/**
 * The tags that OpenBot sets on Agent memory entries. A tag with a colon belongs to OpenBot.
 * The memory Agent never writes them itself, so the model cannot change who sees an entry.
 *
 * - `from:<userId>`: a person who said or did what the entry is about.
 * - `for:person:<userId>`, `for:channel:<channelId>`, `for:agent`: who may see the entry.
 * - `session:<id>`, `channel:<id>`: where the entry comes from.
 * - `org:<organizationId>`: the organization where it happened. Only work in that
 *   organization sees the entry.
 * - `app:<tool>`: a tool result from an App supports the entry.
 */

/** Who may see an entry: one person, the people of one Channel group, or everyone who uses the Agent. */
export type Audience =
	| { readonly _tag: "Person"; readonly id: string }
	| { readonly _tag: "Channel"; readonly id: string }
	| { readonly _tag: "Agent" }

export const person = (id: string): Audience => ({ _tag: "Person", id })
export const channel = (id: string): Audience => ({ _tag: "Channel", id })
export const everyone: Audience = { _tag: "Agent" }

export const fromTag = (userId: string) => "from:" + userId
export const sessionTag = (session: string) => "session:" + session
export const orgTag = (organizationId: string) => "org:" + organizationId
export const channelTag = (channelId: string) => "channel:" + channelId
export const appTag = (tool: string) => "app:" + tool
export const forTag = (audience: Audience) =>
	audience._tag === "Agent"
		? "for:agent"
		: audience._tag === "Person"
			? "for:person:" + audience.id
			: "for:channel:" + audience.id

/** A tag of OpenBot. Topic tags have no colon. */
export const isSystem = (tag: string) => tag.includes(":")

const valuesOf = (tags: ReadonlyArray<string>, prefix: string) =>
	tags
		.filter((tag) => tag.startsWith(prefix))
		.map((tag) => tag.slice(prefix.length))

export const audiencesOf = (tags: ReadonlyArray<string>) =>
	tags.flatMap((tag): ReadonlyArray<Audience> =>
		tag === "for:agent"
			? [everyone]
			: tag.startsWith("for:person:")
				? [person(tag.slice("for:person:".length))]
				: tag.startsWith("for:channel:")
					? [channel(tag.slice("for:channel:".length))]
					: [],
	)
export const peopleOf = (tags: ReadonlyArray<string>) => valuesOf(tags, "from:")
export const orgsOf = (tags: ReadonlyArray<string>) => valuesOf(tags, "org:")

const same = (a: Audience, b: Audience) =>
	a._tag === b._tag && (a._tag === "Agent" || a.id === (b as { id: string }).id)

/**
 * The people who may see both of two entries. `for:agent` is everyone, so it gives the other side.
 * Two different people, or a person and a Channel, give nobody: OpenBot does not know who is
 * in a Channel group, so it does not guess.
 */
export const intersect = (
	a: ReadonlyArray<Audience>,
	b: ReadonlyArray<Audience>,
): ReadonlyArray<Audience> =>
	Arr.dedupeWith(
		a.flatMap((left) =>
			b.flatMap((right): ReadonlyArray<Audience> =>
				left._tag === "Agent"
					? [right]
					: right._tag === "Agent" || same(left, right)
						? [left]
						: [],
			),
		),
		same,
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
		supports.flatMap((tags) =>
			tags.filter(
				(tag) =>
					tag.startsWith("from:") ||
					tag.startsWith("session:") ||
					tag.startsWith("channel:") ||
					tag.startsWith("app:"),
			),
		),
	)
	const [firstOrgs = [], ...otherOrgs] = supports.map(orgsOf)
	const orgs = otherOrgs.reduce<ReadonlyArray<string>>(
		(left, right) => left.filter((org) => right.includes(org)),
		firstOrgs,
	)
	const [firstAudiences = [], ...otherAudiences] = supports.map(audiencesOf)
	const audiences = otherAudiences.reduce(intersect, firstAudiences)
	return [...union, ...orgs.map(orgTag), ...audiences.map(forTag)]
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
	audiencesOf(tags).some((audience) =>
		audience._tag === "Agent"
			? true
			: audience._tag === "Person"
				? viewer.channel === undefined && viewer.person === audience.id
				: viewer.channel === audience.id ||
					(viewer.channel === undefined &&
						viewer.person !== undefined &&
						peopleOf(tags).includes(viewer.person)),
	)
