import { writeFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureAccessToken } from "../../lib/auth.ts";
import {
  listBillingDocuments,
  downloadBillingDocumentPdf,
  type BillingDocument,
} from "../../lib/api.ts";
import { buildBillingBasename, uniqueBasename } from "../../lib/naming.ts";
import { loadManifest, saveManifest } from "../../lib/manifest.ts";

type Options = {
  out: string;
  since?: string;
  customer?: string;
  types: Set<BillingDocument["Type"]>;
  skipExisting: boolean;
};

function parseArgs(args: string[]): Options {
  const opts: Partial<Options> = { skipExisting: true };
  const types = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out" || a === "-o") opts.out = args[++i];
    else if (a === "--since") opts.since = args[++i];
    else if (a === "--customer") opts.customer = args[++i];
    else if (a === "--include") {
      for (const t of (args[++i] ?? "").split(",")) {
        const trimmed = t.trim();
        if (trimmed) types.add(trimmed);
      }
    } else if (a === "--force") opts.skipExisting = false;
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  if (!opts.out) {
    console.error("--out <dir> is required");
    printHelp();
    process.exit(1);
  }
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    console.error("--since must be YYYY-MM-DD");
    process.exit(1);
  }
  if (types.size === 0) {
    types.add("Invoice");
    types.add("CreditNote");
  }
  return { ...(opts as Options), types };
}

function printHelp(): void {
  console.log(`Usage: falco invoices sync --out <dir> [--since YYYY-MM-DD] [--customer <name>] [--include Invoice,CreditNote[,Estimate,Proforma,AdvancePayment]] [--force]

Download every outgoing sales billing document (the "Sales invoices" screen
in Falco) into <dir> as "YYYY-MM-DD_<customer>_<number>.pdf".
Credit notes get a "CN_" prefix on the number.

Options:
  --out <dir>          Target directory (created if missing). Required.
  --since YYYY-MM-DD   Keep only docs whose SendDate/CreationDate is on/after.
  --customer <str>     Keep only docs whose CustomerName contains <str>
                       (case-insensitive substring match).
  --include <types>    Comma-separated list of document types to include.
                       Default: Invoice,CreditNote. Other valid values:
                       Estimate, Proforma, AdvancePayment.
  --force              Re-download even if "<base>.pdf" already exists.`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function renameOne(dir: string, oldBase: string, newBase: string): Promise<void> {
  if (oldBase === newBase) return;
  const oldPath = join(dir, `${oldBase}.pdf`);
  const newPath = join(dir, `${newBase}.pdf`);
  if (await fileExists(oldPath)) await rename(oldPath, newPath);
}

export async function runInvoicesSync(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const { session, accessToken } = await ensureAccessToken();

  await mkdir(opts.out, { recursive: true });

  const r = await listBillingDocuments(accessToken, session.organization_id, {
    Invoices: opts.types.has("Invoice"),
    CreditNotes: opts.types.has("CreditNote"),
    Estimates: opts.types.has("Estimate"),
    AdvancePayments: opts.types.has("AdvancePayment"),
    Proformas: opts.types.has("Proforma"),
  });
  if (!r.ok) {
    console.error(`POST /api.billing/billing-documents/period/<org> failed (${r.status})`);
    console.error(r.bodyText.slice(0, 500));
    return 1;
  }

  let docs: BillingDocument[] = r.data;
  if (opts.since) {
    docs = docs.filter((d) => {
      const date = (d.SendDate ?? d.CreationDate ?? "").slice(0, 10);
      return date >= opts.since!;
    });
  }
  if (opts.customer) {
    const needle = opts.customer.toLowerCase();
    docs = docs.filter((d) => (d.CustomerName ?? "").toLowerCase().includes(needle));
  }
  // Keep only doc types the user actually asked for (list may be over-inclusive).
  docs = docs.filter((d) => opts.types.has(d.Type));

  if (docs.length === 0) {
    console.log("No billing documents match.");
    return 0;
  }

  const manifest = await loadManifest(opts.out);
  const basenameToId = new Map<string, string>();
  for (const [id, base] of Object.entries(manifest.entries)) basenameToId.set(base, id);

  let wrote = 0;
  let skipped = 0;
  let renamed = 0;
  let failed = 0;

  for (const d of docs) {
    let basename = manifest.entries[d.Id];
    const proposed = buildBillingBasename(d);
    if (!basename) {
      basename = uniqueBasename(proposed, (b) => {
        const other = basenameToId.get(b);
        return other !== undefined && other !== d.Id;
      });
      manifest.entries[d.Id] = basename;
      basenameToId.set(basename, d.Id);
    } else {
      const target = uniqueBasename(proposed, (b) => {
        const other = basenameToId.get(b);
        return other !== undefined && other !== d.Id;
      });
      if (target !== basename) {
        basenameToId.delete(basename);
        basenameToId.set(target, d.Id);
        await renameOne(opts.out, basename, target);
        manifest.entries[d.Id] = target;
        basename = target;
        renamed += 1;
      }
    }

    const pdfPath = join(opts.out, `${basename}.pdf`);
    if (opts.skipExisting && (await fileExists(pdfPath))) {
      skipped += 1;
      continue;
    }
    const dl = await downloadBillingDocumentPdf(accessToken, d.Id);
    if (!dl.ok) {
      console.error(`  ✗ ${basename} — HTTP ${dl.status}`);
      failed += 1;
      continue;
    }
    await writeFile(pdfPath, dl.bytes);
    wrote += 1;
    const label = `${(d.SendDate ?? d.CreationDate ?? "?").slice(0, 10)}  ${d.CustomerName ?? "?"}  ${d.FinalAmount ?? "?"} ${d.CurrencyCode ?? ""}`;
    console.log(`  ✓ ${basename}  (${label})`);
  }

  await saveManifest(opts.out, manifest);

  const parts = [
    `${wrote} downloaded`,
    `${skipped} already on disk`,
    `${renamed} renamed`,
    `${failed} failed`,
  ];
  console.log(`\nDone: ${parts.join(", ")}. Dir: ${opts.out}`);
  return failed === 0 ? 0 : 1;
}
