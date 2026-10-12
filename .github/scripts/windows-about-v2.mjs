import assert from "node:assert/strict"
import { execFile, execFileSync, spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

assert.equal(process.platform, "win32", "Capture must run on Windows, without platform emulation")
assert.ok(process.env.OPENCODE_CAPTURE_SOURCE, "OPENCODE_CAPTURE_SOURCE is required")
const source = resolve(process.env.OPENCODE_CAPTURE_SOURCE)
const desktop = join(source, "packages/desktop")
const require = createRequire(join(desktop, "package.json"))
const playwright = createRequire(join(source, "packages/app/package.json"))("@playwright/test")
const expect = playwright.expect.configure({ timeout: 60_000 })
const exec = promisify(execFile)
const output = resolve(process.env.OPENCODE_CAPTURE_OUTPUT ?? join(process.env.GITHUB_WORKSPACE ?? process.cwd(), "windows-about-artifacts"))
const isolated = await mkdtemp(join(tmpdir(), "opencode-about-capture-"))
const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"))
const sourceSHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()
if (process.env.OPENCODE_CAPTURE_SHA) assert.equal(sourceSHA, process.env.OPENCODE_CAPTURE_SHA)
await mkdir(output, { recursive: true })

const logs = []
const errors = []
const summary = {
  passed: false,
  platform: process.platform,
  sourceSHA,
  expectedVersion: manifest.version,
  environment: "GitHub Actions Windows runner; real Electron desktop and source CLI; no browser platform fixture or mock server",
  screenshots: [],
  cycles: [],
}
let application
let page
let server
let traced = false

try {
  summary.os = JSON.parse((await powershell("Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | ConvertTo-Json -Compress")).stdout)
  progress("Launching native Electron")
  application = await playwright._electron.launch({
    executablePath: require("electron"),
    args: [desktop, "--lang=en-US"],
    cwd: desktop,
    env: {
      ...process.env,
      OPENCODE_CHANNEL: "local",
      OPENCODE_VERSION: manifest.version,
      OPENCODE_DISABLE_CHANNEL_DB: "0",
      OPENCODE_DESKTOP_CLI_DEV: join(source, "packages/cli"),
      OPENCODE_DESKTOP_SERVER_CHANNEL: "local",
      OPENCODE_DESKTOP_ISOLATED_SERVER: "1",
      OPENCODE_DESKTOP_TEST_ROOT: isolated,
      OPENCODE_DESKTOP_DISABLE_PROTOCOL_REGISTRATION: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      ELECTRON_ENABLE_LOGGING: "1",
      LANG: "en_US.UTF-8",
    },
    timeout: 180_000,
  })
  progress("Electron launcher connected")
  application.process().stdout?.on("data", (value) => logs.push(`[stdout] ${value}`))
  application.process().stderr?.on("data", (value) => logs.push(`[stderr] ${value}`))
  application.on("console", (message) => logs.push(`[main:${message.type()}] ${message.text()}`))
  const observe = (window) => {
    window.on("console", (message) => logs.push(`[renderer:${message.type()}] ${message.text()}`))
    window.on("pageerror", (error) => errors.push(error.stack ?? String(error)))
  }
  application.on("window", observe)
  application.windows().forEach(observe)
  await application.context().tracing.start({ screenshots: true, snapshots: true, sources: false })
  traced = true
  page = await application.firstWindow({ timeout: 180_000 })
  page.setDefaultTimeout(60_000)
  await page.waitForLoadState("domcontentloaded")
  summary.app = await application.evaluate(({ app }) => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    pid: process.pid,
    electron: process.versions.electron,
    userData: app.getPath("userData"),
  }))
  progress(`Native Electron PID ${summary.app.pid}; version ${summary.app.version}`)
  assert.equal(summary.app.platform, "win32")
  assert.equal(summary.app.name, "OpenCode Dev")
  assert.equal(summary.app.version, manifest.version)
  assert.equal(summary.app.userData, join(isolated, "desktop"))
  const workArea = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  summary.display = workArea
  const window = await application.browserWindow(page)
  await window.evaluate((window, area) => {
    window.restore()
    window.setBounds({ x: area.x + 20, y: area.y + 20, width: Math.min(1180, area.width - 40), height: Math.min(800, area.height - 40) })
    window.show()
    window.focus()
  }, workArea)
  await page.bringToFront()
  // Fresh-profile onboarding runs normally against the real source server. No storage is seeded.
  const menu = page.getByRole("button", { name: "OpenCode menu", exact: true })
  await expect(menu).toBeEnabled({ timeout: 180_000 })
  progress("Production menu enabled")
  await expect(page.locator('[data-component="startup-overlay"]')).toBeHidden({ timeout: 180_000 })
  progress("Startup overlay dismissed")
  const registration = join(isolated, "desktop", "opencode", "service-local.json")
  server = JSON.parse(await readFile(registration, "utf8"))
  assert.equal(server.version, manifest.version)
  assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0)
  summary.server = { mode: "source-cli", mocked: false, version: server.version, pid: server.pid, url: server.url }
  await capture("windows-app-ready")

  const settings = page.getByTestId("settings-screen")
  for (const cycle of [1, 2]) {
    await menu.click()
    await page.getByRole("menuitem", { name: "Help", exact: true }).click()
    const about = page.getByRole("menuitem", { name: "About", exact: true })
    await expect(about).toBeEnabled()
    if (cycle === 1) await capture("windows-about-menu")
    await about.click()
    await expect(settings.getByRole("tab", { name: "About", exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(settings.getByText(`Version ${manifest.version}`, { exact: true })).toBeVisible()
    await expect(settings.getByText("Released under the MIT License", { exact: true })).toBeVisible()
    await capture(cycle === 1 ? "windows-about-page" : "windows-about-reopened")
    summary.cycles.push({ cycle, aboutSelected: true, versionVisible: manifest.version, from: cycle === 1 ? "first-launch app" : "Preferences" })
    if (cycle === 1) {
      const preferences = settings.getByRole("tab", { name: "Preferences", exact: true })
      await preferences.click()
      await expect(preferences).toHaveAttribute("aria-selected", "true")
    }
  }
  summary.passed = true
  progress("Both native About navigation checks passed")
} catch (error) {
  summary.error = error.stack ?? String(error)
  if (page && !page.isClosed()) {
    await capture("failure").catch((error) => logs.push(`[failure capture] ${error}`))
    await writeFile(join(output, "failure.html"), await page.content().catch(() => "")).catch(() => {})
  }
} finally {
  // Save the evidence before teardown: Electron's close promise can remain pending after Windows exits.
  summary.rendererErrors = errors
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2))
  await writeFile(join(output, "console.log"), logs.join("\n"))
  console.log(JSON.stringify(summary, null, 2))
  progress("Evidence saved; starting bounded cleanup")
  if (traced)
    await bounded(application.context().tracing.stop({ path: join(output, "trace.zip") }), "trace stop", 15_000)
  if (application) {
    const closed = await bounded(application.close(), "Electron close", 15_000)
    // Playwright's launcher can exit before the native Electron app. Use the PID read inside Electron.
    if (!closed) {
      const pid = summary.app?.pid ?? application.process().pid
      progress(`Closing capture app PID ${pid}`)
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 })
    }
    await bounded(
      cp(join(isolated, "desktop", "logs"), join(output, "desktop-logs"), { recursive: true }),
      "desktop log copy",
      10_000,
    )
  }
  // Its registration lives in the fresh unique test root, so this cannot target the user's installed service.
  if (!server) server = await readFile(join(isolated, "desktop", "opencode", "service-local.json"), "utf8").then(JSON.parse).catch(() => undefined)
  if (server?.pid) {
    progress(`Closing isolated capture service PID ${server.pid}`)
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 })
  }
  progress("Capture cleanup finished")
  await writeFile(join(output, "console.log"), logs.join("\n"))
}
// Flush output, then exit explicitly so orphaned Playwright transport handles cannot hold the CI step open.
await new Promise((resolve) => process.stdout.write(`Capture result: ${summary.passed ? "passed" : "failed"}\n`, resolve))
process.exit(summary.passed ? 0 : 1)

function progress(message) {
  const line = `[capture] ${new Date().toISOString()} ${message}`
  logs.push(line)
  console.log(line)
}

async function bounded(operation, name, milliseconds) {
  let timer
  try {
    return await Promise.race([
      operation.then(() => true, (error) => {
        progress(`${name} failed: ${error}`)
        return false
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          progress(`${name} reached cleanup deadline`)
          resolve(false)
        }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function powershell(script) {
  return exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000 })
}

async function capture(name) {
  progress(`Capturing ${name}`)
  await page.bringToFront()
  await page.screenshot({ path: join(output, `${name}-renderer.png`) })
  const destination = join(output, `${name}.png`).replaceAll("'", "''")
  await powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name NativeDpi -Namespace Capture
[Capture.NativeDpi]::SetProcessDPIAware() | Out-Null
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save('${destination}', [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`)
  progress(`Saved ${name}`)
  summary.screenshots.push({ name: `${name}.png`, method: "Windows System.Drawing CopyFromScreen (entire desktop)", renderer: `${name}-renderer.png` })
}
