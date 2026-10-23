import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { test } from "node:test"
import {
	ChatSummary,
	AppDiscoveryFailed,
	AppDiscoveryResult,
	AuthApi,
} from "@openbot-build/api"
import { Schema } from "effect"
import * as PostgresTest from "./PostgresTest.ts"
import * as DefaultBot from "./DefaultBot.ts"
import * as Organizations from "./Organizations.ts"

test(
	"built development entry migrates and runs, and production keeps missing-model behavior",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const publicOrigin = "https://localhost:8443"
		const {
			OPENBOT_TLS_CERT: _cert,
			OPENBOT_TLS_KEY: _key,
			...inherited
		} = process.env
		const env = {
			...inherited,
			OPENBOT_DATABASE_URL: database.url,
			OPENBOT_SECRET_KEYS:
				"test:1111111111111111111111111111111111111111111111111111111111111111",
			OPENBOT_HOST: "127.0.0.1",
			OPENBOT_PORT: "0",
			// Only the development entry reads this. It writes the platform settings,
			// so the production entry later serves the same origin and sign-in secret.
			OPENBOT_DEV_PUBLIC_ORIGIN: publicOrigin,
		}
		const start = async (
			entry: "DevelopmentMain" | "Main",
			readyMessage?: string,
		) => {
			const probe = createServer()
			probe.listen(0, "127.0.0.1")
			await once(probe, "listening")
			const address = probe.address()
			assert.ok(address !== null && typeof address !== "string")
			await new Promise<void>((resolve, reject) =>
				probe.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			)
			const child = spawn(process.execPath, [`dist/${entry}.js`], {
				env: { ...env, OPENBOT_PORT: String(address.port) },
				stdio: ["ignore", "pipe", "pipe"],
			})
			let output = ""
			let errors = ""
			const stop = async () => {
				if (child.exitCode !== null || child.signalCode !== null) return
				const exited = once(child, "exit")
				child.kill("SIGINT")
				await exited
			}
			try {
				const address = await new Promise<string>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`Entry did not start: ${errors}`)),
						10000,
					)
					child.stdout.on("data", (chunk: Buffer) => {
						output += chunk.toString()
						const address = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(
							output,
						)?.[1]
						if (
							address !== undefined &&
							(readyMessage === undefined || output.includes(readyMessage))
						) {
							clearTimeout(timer)
							resolve(address)
						}
					})
					child.stderr.on("data", (chunk: Buffer) => {
						errors += chunk.toString()
					})
					child.once("error", (error) => {
						clearTimeout(timer)
						reject(error)
					})
					child.once("exit", (code) => {
						clearTimeout(timer)
						reject(new Error(`Entry exited with ${code}: ${output}\n${errors}`))
					})
				})
				return { address, stop, output: () => output }
			} catch (error) {
				await stop()
				throw error
			}
		}
		try {
			execFileSync(process.execPath, ["dist/Migrate.js"], {
				env,
				stdio: "pipe",
			})
			const development = await start(
				"DevelopmentMain",
				"Development login: POST " + publicOrigin + "/auth/development/sign-in",
			)
			try {
				const login = await fetch(
					development.address + "/auth/development/sign-in",
					{
						method: "POST",
						headers: {
							origin: publicOrigin,
							"content-type": "application/json",
						},
						body: "{}",
					},
				)
				assert.equal(login.status, 200)
				assert.match(
					development.output(),
					/Development login: POST https:\/\/localhost:8443\/auth\/development\/sign-in/,
				)
				const cookie = login.headers
					.getSetCookie()
					.find((value) => value.startsWith(AuthApi.SessionCookie + "="))!
					.split(";")[0]!
				const headers = {
					cookie,
					origin: publicOrigin,
					"content-type": "application/json",
				}
				await Organizations.ensure((path, method, payload) =>
					fetch(development.address + path, {
						method,
						headers,
						...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
					}),
				)
				const defaultBot = (address: string) =>
					DefaultBot.ensure((path, method, payload) =>
						fetch(address + path, {
							method,
							headers,
							...(payload === undefined
								? {}
								: { body: JSON.stringify(payload) }),
						}),
					)
				const discover = (address: string, input: string) =>
					fetch(address + "/v1/apps/discover", {
						method: "POST",
						headers,
						body: JSON.stringify({ input }),
					})
				const discovered = await discover(
					development.address,
					"app.development.test",
				)
				assert.equal(discovered.status, 200)
				const candidate = Schema.decodeUnknownSync(
					Schema.toCodecJson(AppDiscoveryResult),
				)(await discovered.json())
				assert.ok(candidate._tag === "Single")
				assert.equal(
					candidate.candidate.card.name,
					"app.development.test/simulated-app",
				)
				const unknown = await discover(
					development.address,
					"unknown.development.test",
				)
				assert.equal(unknown.status, 422)
				assert.equal(
					Schema.decodeUnknownSync(AppDiscoveryFailed)(await unknown.json())
						.reason,
					"NoDeclaration",
				)
				const bot = await defaultBot(development.address)
				const answer = await fetch(
					development.address + `/v1/bots/${bot}/messages`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							input: "Verify the built entry",
							stream: true,
						}),
					},
				)
				assert.equal(answer.status, 200)
				assert.match(
					await answer.text(),
					/Development response: Verify the built entry/,
				)
				// The development platform gives the new direct Chat a simulated model.
				const [chat] = Schema.decodeUnknownSync(Schema.Array(ChatSummary))(
					await (
						await fetch(development.address + `/v1/chats?bot=${bot}`, {
							headers,
						})
					).json(),
				)
				assert.ok(chat !== undefined)
				const simulatedModel = chat.chat.settings.model
				assert.ok(simulatedModel !== undefined)
				await development.stop()
				const production = await start("Main")
				try {
					const blocked = await discover(
						production.address,
						"https://127.0.0.1/card.json",
					)
					assert.equal(blocked.status, 422)
					assert.equal(
						Schema.decodeUnknownSync(AppDiscoveryFailed)(await blocked.json())
							.reason,
						"BlockedTarget",
					)
					// Production has no default model and no simulated models.
					const talkTo = async (model?: object) => {
						const created = await fetch(production.address + "/v1/bots", {
							method: "POST",
							headers,
							body: JSON.stringify({
								name: "Production helper",
								role: "Helps in production",
								instructions: "Help the person.",
								...(model === undefined ? {} : { model }),
							}),
						})
						assert.equal(created.status, 201, await created.clone().text())
						const { id } = (await created.json()) as { readonly id: string }
						return fetch(production.address + `/v1/bots/${id}/messages`, {
							method: "POST",
							headers,
							body: JSON.stringify({ input: "Hello" }),
						})
					}
					const withoutModel = await talkTo()
					assert.equal(withoutModel.status, 400)
					assert.equal((await withoutModel.json()).reason, "missing")
					const simulated = await talkTo(simulatedModel)
					assert.equal(simulated.status, 400)
					assert.equal((await simulated.json())._tag, "ChatModelInvalid")
					assert.equal(
						production.output().includes("Development login:"),
						false,
					)
				} finally {
					await production.stop()
				}
			} finally {
				await development.stop()
			}
		} finally {
			await database.close()
		}
	},
)
