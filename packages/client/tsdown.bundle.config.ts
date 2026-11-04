import config from "../../tsdown.config.ts"

// Keep workspace imports while we work. Ship the OpenBot code and its types
// inside the client, so apps do not need the other OpenBot packages.
export default {
	...config,
	entry: ["src/index.ts", "src/Api.ts", "src/Core.ts"],
	platform: "neutral" as const,
	unbundle: false,
	deps: {
		neverBundle: true,
		alwaysBundle: [/^@openbot-build\//],
		dts: { alwaysBundle: [/^@openbot-build\//] },
	},
}
