import pkg from "../../package.json";

// Injected at compile time via `bun build --define BUILD_VERSION="\"x.y.z\""`.
declare const BUILD_VERSION: string | undefined;

export function getVersion(): string {
  if (typeof BUILD_VERSION !== "undefined") return BUILD_VERSION;
  return pkg.version;
}
