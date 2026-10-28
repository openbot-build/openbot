import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./ci-resources.sh", import.meta.url))
const call = (name, ...args) =>
	spawnSync(
		"bash",
		["-c", 'source "$1"; shift; "$@"', "resources", script, name, ...args],
		{ encoding: "utf8" },
	)
const temporary = async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "openbot-cgroup-"))
	t.after(() => rm(directory, { recursive: true, force: true }))
	return directory
}

test("cgroup paths account for mount roots and private namespace membership", () => {
	for (const [group, root, mount, expected] of [
		["/job/build", "/", "/sys/fs/cgroup", "/sys/fs/cgroup/job/build"],
		[
			"/docker/job/build",
			"/docker/job",
			"/sys/fs/cgroup",
			"/sys/fs/cgroup/build",
		],
		["/", "/docker/job", "/sys/fs/cgroup", "/sys/fs/cgroup"],
		["/build", "/docker/job", "/sys/fs/cgroup", "/sys/fs/cgroup/build"],
	]) {
		const result = call("cgroup_directory", group, root, mount)
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.stdout.trim(), expected)
	}
})

test("mountinfo resolves v2 and separate v1 memory and CPU controllers", async (t) => {
	const directory = await temporary(t)
	const mountinfo = path.join(directory, "mountinfo")
	await writeFile(
		mountinfo,
		[
			"21 20 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
			"22 20 0:2 /docker/job /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
			"23 20 0:3 /docker/job /sys/fs/cgroup/cpu rw shared:7 - cgroup cgroup rw,cpu,cpuacct",
		].join("\n"),
	)
	for (const [version, controller, expected] of [
		["2", "unified", "/\t/sys/fs/cgroup"],
		["1", "memory", "/docker/job\t/sys/fs/cgroup/memory"],
		["1", "cpu", "/docker/job\t/sys/fs/cgroup/cpu"],
	]) {
		const result = call("cgroup_mounts", mountinfo, version, controller)
		assert.equal(result.status, 0, result.stderr)
		assert.equal(result.stdout.trim(), expected)
	}
})

test("reports the process leaf and ancestor limits instead of assuming the mount root", async (t) => {
	const directory = await temporary(t)
	const leaf = path.join(directory, "build")
	await mkdir(leaf)
	await writeFile(path.join(leaf, "cgroup.procs"), "123\n")
	await writeFile(path.join(leaf, "memory.peak"), "123456\n")
	await writeFile(path.join(leaf, "memory.events"), "oom 1\noom_kill 1\n")
	await writeFile(path.join(directory, "memory.max"), "4294967296\n")
	const result = call(
		"report_hierarchy",
		"123",
		"2",
		"unified",
		"/job/build",
		"/job",
		directory,
	)
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /Target PID membership verified/)
	assert.ok(result.stdout.includes(`${leaf}/memory.peak: 123456`))
	assert.ok(result.stdout.includes(`${directory}/memory.max: 4294967296`))
	assert.match(result.stdout, /oom_kill 1/)
})

for (const [name, command, status] of [
	["success", "exit 0", 0],
	["failure", "exit 37", 37],
	["killed child", "kill -KILL $$", 137],
]) {
	test(`resource reporting retains the command's ${name} exit status`, () => {
		const result = spawnSync("bash", [script, "--run", "bash", "-c", command], {
			encoding: "utf8",
		})
		assert.equal(result.status, status, result.stderr)
		assert.match(result.stdout, /phase=start/)
		assert.match(result.stdout, /phase=exit/)
		assert.ok(result.stdout.includes(`Build command exit status=${status}`))
	})
}
