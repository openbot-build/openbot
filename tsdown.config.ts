import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "src/index.ts",
		Resource: "src/Resource.ts",
		Principal: "src/Principal.ts",
		Domain: "src/Domain.ts",
		Condition: "src/Condition.ts",
		Rule: "src/Rule.ts",
		Policy: "src/Policy.ts",
		Decision: "src/Decision.ts",
		Authorizer: "src/Authorizer.ts",
		HttpApi: "src/HttpApi.ts",
	},
	format: "esm",
	platform: "neutral",
	fixedExtension: false,
	target: "esnext",
	unbundle: true,
	sourcemap: true,
	dts: { sourcemap: true },
	deps: { neverBundle: true },
	exports: { packageJson: false, bin: false },
	report: false,
})
