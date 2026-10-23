// These helpers build shell scripts from values. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import type { ComputersApi } from "@openbot-build/api"
import { quote } from "../Http.ts"

/**
 * The E2B desktop template (https://github.com/e2b-dev/desktop) has Xvfb, XFCE,
 * xdotool, scrot, x11vnc and noVNC. It does not start them by itself: the E2B
 * Desktop SDK starts them with commands after it makes the sandbox. OpenBot does
 * the same with the scripts here. Each script checks first, so it is safe to run
 * again, such as after a resume.
 */
export const template = "desktop"
export const display = ":0"
export const width = 1024
export const height = 768
export const vncPort = 5900
export const streamPort = 6080

/** Starts the X server and the XFCE session, when they do not run yet. */
export const start = [
	`if ! xdpyinfo -display ${display} >/dev/null 2>&1; then`,
	`  setsid nohup Xvfb ${display} -ac -screen 0 ${width}x${height}x24 -retro -dpi 96 -nolisten tcp -nolisten unix >/dev/null 2>&1 &`,
	`  for i in $(seq 1 40); do xdpyinfo -display ${display} >/dev/null 2>&1 && break; sleep 0.25; done`,
	"fi",
	"if ! pgrep -x xfce4-session >/dev/null; then",
	"  setsid nohup startxfce4 >/dev/null 2>&1 &",
	"  for i in $(seq 1 120); do pgrep -x xfwm4 >/dev/null && break; sleep 0.5; done",
	"fi",
].join("\n")

export const screenshotPath = "/tmp/openbot-screenshot.png"

export const screenshot = `${start}\nscrot --overwrite --pointer ${screenshotPath}`

/**
 * Starts the VNC server with a password and noVNC, and prints the password.
 * VNC uses only the first 8 characters of a password.
 */
export const stream = [
	start,
	"mkdir -p ~/.vnc",
	"if ! pgrep -x x11vnc >/dev/null; then",
	"  head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ~/.vnc/openbot-key",
	'  x11vnc -storepasswd "$(cat ~/.vnc/openbot-key)" ~/.vnc/passwd >/dev/null 2>&1',
	`  x11vnc -bg -display ${display} -forever -wait 50 -shared -rfbport ${vncPort} -usepw >/dev/null 2>/tmp/x11vnc_stderr.log`,
	"fi",
	"if ! pgrep -f novnc_proxy >/dev/null; then",
	`  (cd /opt/noVNC/utils && setsid nohup ./novnc_proxy --vnc localhost:${vncPort} --listen ${streamPort} --web /opt/noVNC >/tmp/novnc.log 2>&1 &)`,
	`  for i in $(seq 1 40); do netstat -tuln | grep -q ":${streamPort} " && break; sleep 0.25; done`,
	"fi",
	"cat ~/.vnc/openbot-key",
].join("\n")

/** The names that people and models use, as X key names. */
const keys: Readonly<Record<string, string>> = {
	alt: "Alt_L",
	backspace: "BackSpace",
	cmd: "Super_L",
	command: "Super_L",
	control: "Control_L",
	ctrl: "Control_L",
	del: "Delete",
	delete: "Delete",
	down: "Down",
	end: "End",
	enter: "Return",
	esc: "Escape",
	escape: "Escape",
	home: "Home",
	insert: "Insert",
	left: "Left",
	meta: "Meta_L",
	pagedown: "Page_Down",
	page_down: "Page_Down",
	pageup: "Page_Up",
	page_up: "Page_Up",
	return: "Return",
	right: "Right",
	shift: "Shift_L",
	space: "space",
	super: "Super_L",
	tab: "Tab",
	up: "Up",
	win: "Super_L",
}

export const keyName = (key: string) => {
	const lower = key.toLowerCase()
	return keys[lower] ?? (/^f\d{1,2}$/.test(lower) ? lower.toUpperCase() : key)
}

const buttons = { left: 1, middle: 2, right: 3 } as const

const move = (x: number, y: number) => `xdotool mousemove --sync ${x} ${y}`

const scroll = (button: number, amount: number) =>
	amount === 0 ? [] : [`xdotool click --repeat ${Math.abs(amount)} ${button}`]

const action = (step: ComputersApi.DesktopAction): ReadonlyArray<string> => {
	switch (step._tag) {
		case "Click":
			return [
				move(step.x, step.y),
				`xdotool click${step.double === true ? " --repeat 2" : ""} ${buttons[step.button ?? "left"]}`,
			]
		case "Move":
			return [move(step.x, step.y)]
		case "Drag":
			return [
				move(step.fromX, step.fromY),
				"xdotool mousedown 1",
				move(step.toX, step.toY),
				"xdotool mouseup 1",
			]
		case "Scroll":
			return [
				move(step.x, step.y),
				// X buttons 4 and 5 scroll up and down. 6 and 7 scroll left and right.
				...scroll(step.deltaY < 0 ? 4 : 5, step.deltaY),
				...scroll(step.deltaX < 0 ? 6 : 7, step.deltaX),
			]
		case "Type":
			return [`xdotool type --delay 12 -- ${quote(step.text)}`]
		case "Key":
			return [`xdotool key -- ${quote(step.keys.map(keyName).join("+"))}`]
	}
}

/** One script that does all the actions in order, and stops at the first that fails. */
export const actions = (steps: ReadonlyArray<ComputersApi.DesktopAction>) =>
	[start, ["set -e", ...steps.flatMap(action)].join("\n")].join("\n")
