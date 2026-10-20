import { defineConfig } from "tsdown"
import config from "../../tsdown.config.ts"
export default defineConfig({ ...config, entry: { index: "src/index.ts" } })
