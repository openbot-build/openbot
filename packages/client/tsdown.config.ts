import config from "../../tsdown.config.ts"
export default {
	...config,
	entry: ["src/index.ts", "src/Api.ts", "src/Core.ts"],
}
