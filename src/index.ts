#!/usr/bin/env bun
import { runLogin } from "./commands/login.ts";
import { runWhoami } from "./commands/whoami.ts";
import { runLogout } from "./commands/logout.ts";
import { runPeppolList } from "./commands/peppol/list.ts";
import { runPeppolGet } from "./commands/peppol/get.ts";
import { runPeppolSync } from "./commands/peppol/sync.ts";
import { runPeppolMarkPaid } from "./commands/peppol/mark-paid.ts";
import { runInvoicesSync } from "./commands/invoices/sync.ts";
import { runUpdate } from "./commands/update.ts";
import { AuthError } from "./lib/auth.ts";
import { getVersion } from "./lib/version.ts";

const HELP = `falco — CLI for your Falco account

Usage:
  falco login
  falco whoami
  falco logout
  falco peppol list      [--since YYYY-MM-DD] [--sender <vat>] [--json]
  falco peppol get       <id> [--out <file|dir|->] [--extract-pdf]
  falco peppol sync      --out <dir> [--since YYYY-MM-DD] [--sender <vat>] [--extract-pdf] [--force]
  falco peppol mark-paid <id> [--status Paid|NotPaid] [--unpaid] [--json]
  falco invoices sync    --out <dir> [--since YYYY-MM-DD] [--customer <name>] [--include Invoice,CreditNote] [--force]
  falco update           [--check] [--force] [-y]

Options:
  -h, --help       Show this help.
  -v, --version    Show the version.

Most commands are read-only; \`peppol mark-paid\` writes the invoice payment status.
`;

async function runInvoices(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "sync":
      return runInvoicesSync(rest);
    case undefined:
    case "-h":
    case "--help":
      console.log(HELP);
      return sub === undefined ? 1 : 0;
    default:
      console.error(`Unknown invoices subcommand: ${sub}\n`);
      console.log(HELP);
      return 1;
  }
}

async function runPeppol(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return runPeppolList(rest);
    case "get":
      return runPeppolGet(rest);
    case "sync":
      return runPeppolSync(rest);
    case "mark-paid":
      return runPeppolMarkPaid(rest);
    case undefined:
    case "-h":
    case "--help":
      console.log(HELP);
      return sub === undefined ? 1 : 0;
    default:
      console.error(`Unknown peppol subcommand: ${sub}\n`);
      console.log(HELP);
      return 1;
  }
}

async function main(): Promise<number> {
  const [, , ...argv] = process.argv;
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
    console.log(getVersion());
    return 0;
  }
  const [verb, ...rest] = argv;
  switch (verb) {
    case "login":
      return runLogin(rest);
    case "whoami":
      return runWhoami(rest);
    case "logout":
      return runLogout(rest);
    case "peppol":
      return runPeppol(rest);
    case "invoices":
      return runInvoices(rest);
    case "update":
      return runUpdate(rest);
    default:
      console.error(`Unknown command: ${verb}\n`);
      console.log(HELP);
      return 1;
  }
}

// No top-level await: `bun build --bytecode` does not support it.
main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof AuthError) {
      console.error(e.message);
      process.exit(1);
    }
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  },
);
