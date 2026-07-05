import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { prompt } from "../lib/prompt.ts";
import { getVersion } from "../lib/version.ts";

const GITHUB_REPO = "plosson/falco-cli";

const HELP = `falco update — update falco to the latest release

Usage:
  falco update [--check] [--force] [-y]

Options:
  --check          Only check for updates, don't install.
  --force          Reinstall even if already on the latest version.
  -y, --yes        Skip the confirmation prompt.
  -h, --help       Show this help.
`;

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

function getPlatform(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

function isCompiledBinary(): boolean {
  // In compiled bun binaries, argv[0] is just "bun" (no path);
  // in dev mode it is a full path like "/Users/.../bun".
  return process.argv[0] === "bun" && !process.execPath.endsWith("/bun");
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "falco-updater",
    },
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error("No releases found");
    throw new Error(`Failed to fetch release info: ${res.statusText}`);
  }
  return res.json() as Promise<GitHubRelease>;
}

function compareVersions(current: string, latest: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return 1;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return -1;
  }
  return 0;
}

function renderProgress(received: number, total: number, done = false): void {
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
  const width = 30;
  let line: string;
  if (total > 0) {
    const pct = Math.min(100, Math.floor((received / total) * 100));
    const filled = Math.floor((pct / 100) * width);
    line = `  [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${pct}% (${mb(received)}/${mb(total)} MB)`;
  } else {
    line = `  Downloaded ${mb(received)} MB`;
  }
  process.stderr.write(`\r\x1b[K${line}`);
  if (done) process.stderr.write("\n");
}

async function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve) => stream.once("drain", resolve));
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "falco-updater" } });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.statusText}`);

  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;
  let lastRender = 0;
  const showProgress = process.stderr.isTTY;

  const file = fs.createWriteStream(dest);
  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeChunk(file, value);
      received += value.length;
      if (showProgress) {
        const now = Date.now();
        if (now - lastRender > 100) {
          renderProgress(received, total);
          lastRender = now;
        }
      }
    }
    if (showProgress) renderProgress(received, total, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err: unknown) {
    // Cross-device rename fails with EXDEV; fall back to copy+delete.
    if (err && typeof err === "object" && "code" in err && err.code === "EXDEV") {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

async function updateBinary(downloadUrl: string, targetPath: string): Promise<void> {
  // Download next to the target so the final rename stays on one filesystem.
  const tmpFile = path.join(path.dirname(targetPath), `.falco-update-${Date.now()}`);

  console.error("Downloading update...");
  await downloadBinary(downloadUrl, tmpFile);

  if (fs.statSync(tmpFile).size === 0) {
    fs.unlinkSync(tmpFile);
    throw new Error("Downloaded file is empty");
  }

  let originalMode = 0o755;
  try {
    originalMode = fs.statSync(targetPath).mode;
  } catch {
    // Use the default if the original can't be read.
  }

  console.error("Installing update...");
  // The running process keeps the old inode open, so renaming over it is safe.
  fs.chmodSync(tmpFile, originalMode);
  moveFile(tmpFile, targetPath);
}

export async function runUpdate(args: string[]): Promise<number> {
  let check = false;
  let force = false;
  let yes = false;
  for (const arg of args) {
    switch (arg) {
      case "--check":
        check = true;
        break;
      case "--force":
        force = true;
        break;
      case "-y":
      case "--yes":
        yes = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        return 0;
      default:
        console.error(`Unknown option: ${arg}\n`);
        console.log(HELP);
        return 1;
    }
  }

  const currentVersion = getVersion();
  const platform = getPlatform();
  const assetName = `falco-${platform}`;

  console.error(`Current version: ${currentVersion}`);
  console.error("Checking for updates...");

  const release = await fetchLatestRelease();
  const latestVersion = release.tag_name.replace(/^v/, "");
  const comparison = compareVersions(currentVersion, latestVersion);

  if (comparison === 0 && !force) {
    console.log(`Already on the latest version (${currentVersion})`);
    return 0;
  }
  if (comparison < 0 && !force) {
    console.log(`Current version (${currentVersion}) is newer than latest release (${latestVersion})`);
    return 0;
  }

  console.log(`New version available: ${latestVersion}`);
  if (check) return 0;

  if (!isCompiledBinary()) {
    console.error("The update command only works with compiled binaries.");
    console.error("In development, use git pull and bun install instead.");
    return 1;
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    console.error(`No binary found for ${platform}.`);
    console.error(`Available assets: ${release.assets.map((a) => a.name).join(", ")}`);
    return 1;
  }

  if (!yes) {
    const answer = (await prompt(`Update from ${currentVersion} to ${latestVersion}? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.error("Update cancelled");
      return 0;
    }
  }

  try {
    await updateBinary(asset.browser_download_url, process.execPath);
    console.log(`Successfully updated to version ${latestVersion}`);
    return 0;
  } catch (error) {
    console.error("");
    console.error("Automatic update failed. You can reinstall manually:");
    console.error("");
    console.error(`  curl -LsSf https://falco.houlahop.com/install | sh`);
    console.error("");
    throw error;
  }
}
