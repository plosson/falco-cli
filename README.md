# falco

CLI for your Falco account — sync received peppol invoices, issued sales invoices and payment status from the terminal.

## Install

```sh
curl -LsSf https://falco.houlahop.com/install | sh
```

Supported platforms: macOS (Apple Silicon), Linux x64 / arm64. The installer downloads a single self-contained binary from GitHub Releases into `~/.local/bin` (override with `FALCO_INSTALL_DIR` or `--install-dir`).

## Usage

```
falco login
falco whoami
falco logout
falco peppol list      [--since YYYY-MM-DD] [--sender <vat>] [--json]
falco peppol get       <id> [--out <file|dir|->] [--extract-pdf]
falco peppol sync      --out <dir> [--since YYYY-MM-DD] [--sender <vat>] [--extract-pdf] [--force]
falco peppol mark-paid <id> [--status Paid|NotPaid] [--unpaid] [--json]
falco invoices sync    --out <dir> [--since YYYY-MM-DD] [--customer <name>] [--include Invoice,CreditNote] [--force]
falco update           [--check] [--force] [-y]
```

Most commands are read-only; `peppol mark-paid` writes the invoice payment status.

## Updating

```sh
falco update
```

Checks GitHub Releases for a newer version and replaces the running binary in place.

## Development

Requires [bun](https://bun.sh).

```sh
bun install
bun run dev -- --help     # run from source
bun run typecheck         # tsc --noEmit
bun run build:native      # compile a local binary to dist/falco
```

## Releasing

1. Bump `version` in `package.json`
2. `git commit -am "Bump version to X.Y.Z" && git push`
3. `git tag vX.Y.Z && git push origin vX.Y.Z`

The release workflow validates the tag against `package.json`, cross-compiles binaries for all targets (`bun build --compile`), and publishes them with checksums to GitHub Releases.
