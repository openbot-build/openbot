import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Context,
	Effect,
	HashSet,
	Layer,
	pipe,
	Result,
	String as Str,
} from "effect"
import { IpNetwork, NetAddress } from "effect/net"

/**
 * The private targets that the operator opens on purpose, from
 * `OPENBOT_OUTBOUND_ALLOW`. Every other target must be a public address.
 */
export interface Allow {
	/** Exact host names, in lower case and without a trailing dot. */
	readonly hostnames: HashSet.HashSet<string>
	/** IP ranges. A single address is a range with a full prefix. */
	readonly networks: ReadonlyArray<IpNetwork.IpNetwork>
}

export const empty: Allow = { hostnames: HashSet.empty(), networks: [] }

const hostnamePattern =
	/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/

const normalizeHostname = (hostname: string) =>
	pipe(hostname, Str.toLowerCase, Str.replace(/\.$/, ""))

const parseAddress = (input: string) =>
	NetAddress.ipFromString(pipe(input, Str.replace(/^\[|\]$/g, "")))

const parseEntry = (
	entry: string,
): Result.Result<
	| { readonly _tag: "Hostname"; readonly hostname: string }
	| {
			readonly _tag: "Network"
			readonly network: IpNetwork.IpNetwork
	  },
	string
> => {
	const invalid = Result.fail(
		`OPENBOT_OUTBOUND_ALLOW has an invalid entry "${entry}". Use an IP address, an IP range such as 10.0.0.0/8, or an exact host name.`,
	)
	if (pipe(entry, Str.includes("/")))
		return Result.match(IpNetwork.fromString(entry), {
			onFailure: () => invalid,
			onSuccess: (network) =>
				Result.succeed({ _tag: "Network" as const, network }),
		})
	const address = parseAddress(entry)
	if (Result.isSuccess(address)) {
		const canonical = NetAddress.toCanonical(address.success)
		return Result.match(
			IpNetwork.fromAddress(
				canonical,
				NetAddress.isIpv6Address(canonical) ? 128 : 32,
			),
			{
				onFailure: () => invalid,
				onSuccess: (network) =>
					Result.succeed({ _tag: "Network" as const, network }),
			},
		)
	}
	const hostname = normalizeHostname(entry)
	return hostnamePattern.test(hostname)
		? Result.succeed({ _tag: "Hostname" as const, hostname })
		: invalid
}

/** Reads a comma-separated list. The first invalid entry is the failure message. */
export const parse = (input: string): Result.Result<Allow, string> =>
	pipe(
		Str.split(input, ","),
		Arr.map(Str.trim),
		Arr.filter(Str.isNonEmpty),
		Arr.map(parseEntry),
		Result.all,
		Result.map(
			Arr.reduce(empty, (allow, entry): Allow =>
				entry._tag === "Hostname"
					? {
							...allow,
							hostnames: HashSet.add(allow.hostnames, entry.hostname),
						}
					: { ...allow, networks: [...allow.networks, entry.network] },
			),
		),
	)

/**
 * Says if a connection may use `address`, which a DNS lookup of `hostname`
 * returned. For an IP literal, both values are the same.
 */
export const allowAddress =
	(allow: Allow) =>
	(address: string, hostname: string): boolean => {
		if (NodeHttpServer.isPublicAddress(address)) return true
		if (HashSet.has(allow.hostnames, normalizeHostname(hostname))) return true
		const parsed = parseAddress(address)
		if (Result.isFailure(parsed)) return false
		const canonical = NetAddress.toCanonical(parsed.success)
		return Arr.some(allow.networks, (network) =>
			IpNetwork.contains(network, canonical),
		)
	}

/**
 * The address rule that every outbound connection uses. The default allows
 * only public addresses. The entry points set it from `OPENBOT_OUTBOUND_ALLOW`.
 */
export const OutboundPolicy = Context.Reference<{
	readonly allow: Allow
	readonly allowAddress: (address: string, hostname: string) => boolean
}>("@openbot-build/openbot/network/OutboundPolicy", {
	defaultValue: () => ({
		allow: empty,
		allowAddress: NodeHttpServer.isPublicAddress,
	}),
})

export const make = (allow: Allow) => ({
	allow,
	allowAddress: allowAddress(allow),
})

/** The public network of the protocol library, with the current address rule. */
export const layerPublicNetwork = Layer.unwrap(
	Effect.gen(function* () {
		const policy = yield* OutboundPolicy
		return NodeHttpServer.layerPublicNetwork({
			allowAddress: policy.allowAddress,
		})
	}),
)
