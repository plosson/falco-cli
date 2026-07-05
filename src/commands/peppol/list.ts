import { ensureAccessToken } from "../../lib/auth.ts";
import {
  listPeppolDocuments,
  type PeppolDocumentListItem,
} from "../../lib/api.ts";

type Options = {
  since?: string; // YYYY-MM-DD
  sender?: string; // VAT number filter (case-insensitive, substring)
  json: boolean;
};

function parseArgs(args: string[]): Options {
  const opts: Options = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") opts.json = true;
    else if (a === "--since") opts.since = args[++i];
    else if (a === "--sender") opts.sender = args[++i];
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    console.error("--since must be YYYY-MM-DD");
    process.exit(1);
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: falcio peppol list [--since YYYY-MM-DD] [--sender <vat>] [--json]

Lists inbound Peppol documents for the active organization. Default filters
include every import state (imported / not-imported / processing / accepted
/ rejected / no-response) and exclude self-billing.

Options:
  --since YYYY-MM-DD   Keep only docs whose documentDate is on/after this date.
  --sender <vat>       Keep only docs whose supplierVatNumber contains <vat>
                       (case-insensitive, substring match).
  --json               Output the raw JSON array instead of a table.`);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function fmtAmount(amount: string | null, currency: string | null): string {
  if (!amount) return "—";
  const c = currency === "EUR" ? "€" : (currency ?? "");
  return `${amount} ${c}`.trim();
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n - 1) + "…";
  return s + " ".repeat(n - s.length);
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n - 1) + "…";
  return " ".repeat(n - s.length) + s;
}

export async function runPeppolList(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const { session, accessToken } = await ensureAccessToken();
  const r = await listPeppolDocuments(accessToken, session.organization_id);
  if (!r.ok) {
    console.error(`GET /peppol/documents/${session.organization_id} failed (${r.status})`);
    console.error(r.bodyText.slice(0, 500));
    return 1;
  }

  let docs: PeppolDocumentListItem[] = r.data;
  if (opts.since) {
    docs = docs.filter((d) => (d.documentDate ?? "").slice(0, 10) >= opts.since!);
  }
  if (opts.sender) {
    const needle = opts.sender.toLowerCase();
    docs = docs.filter((d) =>
      (d.supplierVatNumber ?? "").toLowerCase().includes(needle) ||
      (d.supplierName ?? "").toLowerCase().includes(needle),
    );
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(docs, null, 2) + "\n");
    return 0;
  }

  if (docs.length === 0) {
    console.log("No Peppol documents match.");
    return 0;
  }

  const header =
    pad("DATE", 11) +
    pad("NUMBER", 18) +
    pad("SUPPLIER", 40) +
    padRight("AMOUNT", 14) +
    "  " +
    pad("STATE", 14) +
    "ID";
  console.log(header);
  console.log("-".repeat(header.length));
  for (const d of docs) {
    console.log(
      pad(fmtDate(d.documentDate), 11) +
        pad(d.documentNumber ?? "—", 18) +
        pad(
          `${d.supplierName ?? "?"}${d.supplierVatNumber ? ` (${d.supplierVatNumber})` : ""}`,
          40,
        ) +
        padRight(fmtAmount(d.amount, d.currency), 14) +
        "  " +
        pad(d.importState ?? "—", 14) +
        d.id,
    );
  }
  console.log(`\n${docs.length} document(s)`);
  return 0;
}
