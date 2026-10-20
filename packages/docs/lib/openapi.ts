import { createOpenAPI } from "fumadocs-openapi/server"

// scripts/api.ts writes this file from the Platform API contract.
export const openapi = createOpenAPI({
	input: ["./openapi.json"],
})
