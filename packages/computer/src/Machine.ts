import { arch, hostname, platform } from "node:os"
import { ComputersApi } from "@openbot-build/api"

/** The version of this connector program. */
export const version = "0.1.0"

/** What the connector tells OpenBot about this machine. It has no desktop yet. */
export const hello = (): ComputersApi.ConnectorHello => ({
	version: ComputersApi.connectorProtocolVersion,
	os: platform(),
	arch: arch(),
	desktop: false,
})

/** The name of this machine, cut to the longest name that OpenBot takes. */
export const name = (): string => {
	const value = hostname().slice(0, 253)
	return value === "" ? "computer" : value
}
