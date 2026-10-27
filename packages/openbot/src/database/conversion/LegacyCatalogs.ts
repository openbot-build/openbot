import { Schema, Array as Arr, String as Str } from "effect"
import * as Apps from "./LegacyApps.ts"

/** Saved catalog forms at 2a123ff. These codecs do not use current HTTP models. */
const extensions = Schema.Record(Schema.String, Schema.Json)
const uri = Schema.String.check(
	Schema.makeFilter((value) => URL.canParse(value)),
)
export const Link = Schema.String.check(
	Schema.makeFilter((value) => {
		if (!URL.canParse(value)) return false
		const url = new URL(value)
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.hash === ""
		)
	}),
)
const inputFields = {
	description: Schema.optionalKey(Schema.String),
	isRequired: Schema.optionalKey(Schema.Boolean),
	isSecret: Schema.optionalKey(Schema.Boolean),
	format: Schema.optionalKey(
		Schema.Literals(["string", "number", "boolean", "filepath"]),
	),
	default: Schema.optionalKey(Schema.String),
	placeholder: Schema.optionalKey(Schema.String),
	value: Schema.optionalKey(Schema.String),
	choices: Schema.optionalKey(Schema.Array(Schema.String)),
}
const field = Schema.StructWithRest(Schema.Struct(inputFields), [extensions])
const header = Schema.StructWithRest(
	Schema.Struct({
		...inputFields,
		name: Schema.String.check(
			Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
		),
		variables: Schema.optionalKey(Schema.Record(Schema.String, field)),
	}),
	[extensions],
)
const remote = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.Literals(["streamable-http", "sse"]),
		url: Schema.String.check(
			Schema.isPattern(
				/^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/,
			),
		),
		headers: Schema.optionalKey(Schema.Array(header)),
		variables: Schema.optionalKey(Schema.Record(Schema.String, field)),
		supportedProtocolVersions: Schema.optionalKey(Schema.Array(Schema.String)),
	}),
	[extensions],
)
export const Card = Schema.StructWithRest(
	Schema.Struct({
		$schema: Schema.Literal(
			"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
		),
		name: Schema.String.check(
			Schema.isPattern(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
			Schema.isMinLength(3),
			Schema.isMaxLength(200),
		),
		version: Schema.NonEmptyString.check(
			Schema.isMaxLength(255),
			Schema.makeFilter((value) => !/[\s^~*<>=|]|(^|\.)x($|\.)/i.test(value)),
		),
		description: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
		title: Schema.optionalKey(
			Schema.NonEmptyString.check(Schema.isMaxLength(100)),
		),
		websiteUrl: Schema.optionalKey(uri),
		repository: Schema.optionalKey(
			Schema.StructWithRest(
				Schema.Struct({
					url: uri,
					source: Schema.String,
					subfolder: Schema.optionalKey(
						Schema.String.check(
							Schema.makeFilter(
								(value) =>
									!Str.startsWith("/")(value) &&
									!Arr.contains(Str.split(value, "/"), ".."),
							),
						),
					),
					id: Schema.optionalKey(Schema.String),
				}),
				[extensions],
			),
		),
		icons: Schema.optionalKey(
			Schema.Array(
				Schema.StructWithRest(
					Schema.Struct({
						src: uri,
						mimeType: Schema.optionalKey(Schema.String),
						sizes: Schema.optionalKey(Schema.Array(Schema.String)),
						theme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
					}),
					[extensions],
				),
			),
		),
		remotes: Schema.optionalKey(Schema.Array(remote)),
		_meta: Schema.optionalKey(extensions),
	}),
	[extensions],
)
export const Sources = Apps.Test.fields.candidate.fields.sources
export const Candidate = Schema.Struct({
	...Apps.Test.fields.candidate.fields,
	card: Card,
	endpoints: Schema.Array(
		Schema.Struct({
			index: Schema.Natural,
			remote,
			requirements: Schema.Array(
				Schema.Struct({
					key: Schema.String,
					description: Schema.optionalKey(Schema.String),
					isSecret: Schema.Boolean,
					format: Schema.optionalKey(Schema.String),
					choices: Schema.optionalKey(Schema.Array(Schema.String)),
				}),
			),
		}),
	),
})
export const AppRecord = Schema.Struct({
	cardUrl: Schema.String,
	card: Card,
	sources: Sources,
})
const discoveryIssue = Schema.Struct({
	url: Schema.String,
	reason: Schema.String,
	fieldPath: Schema.optionalKey(Schema.String),
})
export const Draft = Schema.Struct({
	id: Schema.NonEmptyString,
	revision: Schema.Natural,
	input: Schema.NonEmptyString,
	discovery: Schema.TaggedUnion({
		Single: { candidate: Candidate, issues: Schema.Array(discoveryIssue) },
		Multiple: {
			candidates: Schema.Array(Candidate).check(Schema.isMinLength(2)),
			issues: Schema.Array(discoveryIssue),
		},
	}),
	expiresAt: Schema.Finite,
	imported: Schema.optionalKey(
		Schema.Struct({
			name: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
			remoteIndex: Schema.Natural,
		}),
	),
})
const restriction = Schema.Struct({
	cardUrl: Link,
	reason: Schema.NonEmptyString,
	appealUrl: Link,
})
export const Availability = Schema.TaggedUnion({
	PendingConfiguration: {},
	PendingAuthorization: { scopes: Schema.Array(Schema.String) },
	Unverified: {},
	Available: { checkedAt: Schema.Finite, revision: Schema.Natural },
	AuthorizationExpired: {},
	ConnectionFailed: { message: Schema.String },
	NeedsRevalidation: {},
	CleanupPending: { stage: Schema.Literals(["Credentials", "Connection"]) },
	Restricted: { restriction },
})
export const StoredConnection = Schema.Struct({
	connection: Apps.Connection,
	name: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
	revision: Schema.Natural,
	verification: Schema.NullOr(Availability),
})
export const Check = Schema.TaggedUnion({
	Pending: {},
	Indexed: { attemptedAt: Schema.Finite },
	Excluded: { attemptedAt: Schema.Finite, reason: Schema.String },
	Withdrawn: { attemptedAt: Schema.Finite, reason: Schema.String },
	Unconfirmed: { attemptedAt: Schema.Finite, reason: Schema.String },
	Failed: { attemptedAt: Schema.Finite, reason: Schema.String },
})
export const Entry = Schema.Struct({
	cardUrl: Link,
	card: Card,
	evidence: Schema.NonEmptyArray(
		Schema.Struct({
			publisherUrl: Link,
			catalogUrl: Link,
			cardUrl: Link,
			association: Schema.Literals(["CardOrigin", "Website", "CardLink"]),
		}),
	),
	checkedAt: Schema.Finite,
	validators: Schema.Struct({
		etag: Schema.optionalKey(Schema.String),
		lastModified: Schema.optionalKey(Schema.String),
	}),
})
const stage = Schema.Struct({
	name: Schema.Literals([
		"Input",
		"Discovery",
		"CardRead",
		"CardSchema",
		"Compatibility",
		"PublisherAssociation",
		"Eligibility",
	]),
	source: Schema.String,
	status: Schema.Literals(["Passed", "Failed", "Unconfirmed", "NotChecked"]),
	checkedAt: Schema.optionalKey(Schema.Finite),
	reason: Schema.optionalKey(Schema.String),
})
const eligibility = Schema.TaggedUnion({
	Eligible: { entry: Entry, stages: Schema.Array(stage) },
	Excluded: {
		stages: Schema.Array(stage),
		cardUrl: Link,
		reason: Schema.String,
		withdraw: Schema.Boolean,
	},
	Unconfirmed: {
		stages: Schema.Array(stage),
		cardUrl: Link,
		reason: Schema.String,
		url: Schema.String,
		issue: Schema.String,
	},
})
export const Issue = Schema.Struct({
	code: Schema.String,
	impacts: Schema.optionalKey(
		Schema.Array(Schema.Literals(["discovery", "indexing", "connection"])),
	),
	stage: Schema.Literals(["publication", "catalog", "card", "indexing"]),
	severity: Schema.Literals(["blocking", "suggestion"]),
	source: Schema.String,
	fieldPath: Schema.optionalKey(Schema.String),
	message: Schema.String,
	repair: Schema.String,
})
export const Report = Schema.Struct({
	input: Schema.String,
	checkedAt: Schema.Finite,
	apps: Schema.Array(
		Schema.Struct({
			candidate: Candidate,
			eligibility,
			stored: Schema.TaggedUnion({
				Known: { check: Schema.NullOr(Check) },
				Unknown: {},
			}),
		}),
	),
	issues: Schema.Array(Issue),
	stages: Schema.Array(stage),
})
export const ManagementScope = Schema.TaggedUnion({
	PublisherHostname: { hostname: Schema.NonEmptyString },
	AppCard: { cardUrl: Link },
})
const base = { namespace: Schema.NonEmptyString }
const owner = { owner: Schema.NonEmptyString }
const id = { id: Schema.NonEmptyString }
const card = { card_url: Schema.NonEmptyString }
const json = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Schema.fromJsonString(schema)
export const Claim = Schema.Struct({
	...base,
	...owner,
	...id,
	scope_key: Schema.NonEmptyString,
	scope: json(ManagementScope),
	token: Schema.NonEmptyString,
	status: Schema.Literals(["Pending", "Confirmed", "Revoked", "Expired"]),
	created_at: Schema.Finite,
	expires_at: Schema.Finite,
})
export const Proof = Schema.Struct({
	...base,
	...owner,
	...id,
	scope_key: Schema.NonEmptyString,
	scope: json(ManagementScope),
	token: Schema.NonEmptyString,
	transition: Schema.Natural,
	status: Schema.Literals([
		"Confirmed",
		"Unconfirmed",
		"Suspended",
		"Relinquished",
	]),
	confirmed_at: Schema.NullOr(Schema.Finite),
	valid_until: Schema.Finite,
	next_verification_at: Schema.Finite,
	reason: Schema.NullOr(Schema.String),
})
export const Member = Schema.Struct({
	...base,
	...owner,
	...id,
	proof_id: Schema.NonEmptyString,
	role: Schema.Literals(["maintainer", "viewer"]),
})
export const Invitation = Schema.Struct({
	...Member.fields,
	expires_at: Schema.Finite,
	status: Schema.Literals(["Pending", "Accepted", "Revoked"]),
	accepted_by: Schema.NullOr(Schema.String),
})
export const DeveloperApp = Schema.Struct({
	...base,
	...card,
	candidate: json(Candidate),
	next_check_at: Schema.Finite,
	lease_until: Schema.Finite,
	monitor_token: Schema.NullOr(Schema.String),
	monitor_revision: Schema.Natural,
	monitor_issues: json(Schema.Array(Issue)),
})
export const DeveloperReport = Schema.Struct({
	...base,
	...id,
	...card,
	owner: Schema.NullOr(Schema.String),
	checked_at: Schema.Finite,
	report: json(Report),
})
export const IndexRequest = Schema.Struct({
	...base,
	...id,
	...owner,
	...card,
	generation: Schema.NonEmptyString,
	accepted_at: Schema.Finite,
})
export const IndexRequestHistory = Schema.TaggedStruct("IndexRequest", {
	version: Schema.Literal(1),
	request: IndexRequest,
	check: Schema.NullOr(Check),
})
export const IndexJob = Schema.Struct({
	...base,
	...card,
	next_check_at: Schema.Finite,
	lease_until: Schema.Finite,
	claim: Schema.NullOr(Schema.String),
	check: Schema.NullOr(json(Check)),
	generation: Schema.String,
	completed_generation: Schema.NullOr(Schema.String),
	sources: json(Sources),
	requested_at: Schema.Finite,
	started_at: Schema.Finite,
})
export const IndexResult = Schema.Struct({
	...base,
	...card,
	generation: Schema.NonEmptyString,
	check: json(Check),
	finished_at: Schema.Finite,
})
export const Subscription = Schema.Struct({
	...base,
	...owner,
	...card,
	enabled: Schema.Boolean,
})
export const Notice = Schema.Struct({
	...base,
	...owner,
	...id,
	card_url: Schema.NullOr(Schema.String),
	kind: Schema.Literals(["IssueAppeared", "IssueResolved", "AccessChanged"]),
	issue: Schema.NullOr(json(Issue)),
	reason: Schema.NullOr(Schema.String),
	report_id: Schema.NullOr(Schema.String),
	created_at: Schema.Finite,
	read_at: Schema.NullOr(Schema.Finite),
})
export const AppRow = Schema.Struct({ ...owner, ...card, body: Schema.String })
export const DraftRow = Schema.Struct({ ...owner, ...id, body: Schema.String })
export const ConnectionRow = Schema.Struct({
	...owner,
	...id,
	name: Schema.String,
	revision: Schema.Natural,
	body: Schema.String,
	verification: Schema.NullOr(Schema.String),
})
export const EntryRow = Schema.Struct({ ...base, ...card, body: Schema.String })
