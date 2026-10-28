import config from "../../tsdown.config.ts"

// Workspace builds keep shared type identities across the server and client.
export default {
	...config,
	entry: ["src/index.ts", "src/Api.ts", "src/Core.ts"],
}
