import { ensureAccessToken } from "../../lib/auth.ts";
import {
  listAllInvoices,
  setInvoicePaymentStatus,
  type InvoiceListItem,
  type InvoicePaymentStatus,
} from "../../lib/api.ts";

type Options = {
  ref: string; // peppol document id, invoice number, or document id
  status: InvoicePaymentStatus;
  json: boolean;
};

function parseArgs(args: string[]): Options {
  const opts: Partial<Options> = { status: "Paid", json: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--status") {
      const v = args[++i];
      if (v !== "Paid" && v !== "NotPaid") {
        console.error(`--status must be "Paid" or "NotPaid", got: ${v}`);
        printHelp();
        process.exit(1);
      }
      opts.status = v;
    } else if (a === "--unpaid") {
      opts.status = "NotPaid";
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    console.error("Expected exactly one argument: peppol document id, invoice number, or document id.");
    printHelp();
    process.exit(1);
  }
  return { ref: positional[0]!, status: opts.status!, json: !!opts.json };
}

function printHelp(): void {
  console.log(`Usage: falcio peppol mark-paid <id> [--status Paid|NotPaid] [--unpaid] [--json]

Manually set the payment status of a received invoice in Falco.

Positional:
  <id>   Identifies the invoice by any of: peppol document id (UUID, as listed by
         \`falcio peppol list\`), invoice number (e.g. "I-2026-067"), or the
         internal document id.

Options:
  --status <Paid|NotPaid>   Status to set. Default: Paid.
  --unpaid                  Shortcut for --status NotPaid.
  --json                    Print the resulting invoice record as JSON.

Notes:
  - This is a write operation. It mirrors the desktop app's "mark as paid" for a
    standalone (non-fiduciary) account and is reversible with --unpaid.
  - Payment status is a bookkeeping flag in Falco; it is not reconciled against
    your bank feed.`);
}

function matches(inv: InvoiceListItem, ref: string): boolean {
  return (
    inv.id === ref ||
    inv.peppolInvoiceId === ref ||
    inv.invoiceReference === ref
  );
}

export async function runPeppolMarkPaid(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const { session, accessToken } = await ensureAccessToken();

  const list = await listAllInvoices(accessToken, session.organization_id);
  if (!list.ok) {
    console.error(`GET /document/invoices failed (${list.status})`);
    console.error(list.bodyText.slice(0, 500));
    return 1;
  }

  const found = list.data.filter((d) => matches(d, opts.ref));
  if (found.length === 0) {
    console.error(`No invoice found matching "${opts.ref}".`);
    console.error("Pass a peppol document id, invoice number, or document id (see `falcio peppol list`).");
    return 1;
  }
  if (found.length > 1) {
    console.error(`Ambiguous: "${opts.ref}" matches ${found.length} invoices:`);
    for (const d of found) {
      console.error(`  ${d.invoiceReference ?? "(no ref)"}  doc=${d.id}  peppol=${d.peppolInvoiceId ?? "-"}`);
    }
    console.error("Re-run with the unambiguous document id.");
    return 1;
  }

  const inv = found[0]!;
  const label = `${inv.invoiceReference ?? inv.id} (${inv.supplierName ?? "?"}, €${inv.amount ?? "?"})`;

  if (inv.paymentStatus === opts.status) {
    console.error(`${label} is already ${opts.status}; nothing to do.`);
    if (opts.json) console.log(JSON.stringify(inv, null, 2));
    return 0;
  }

  const r = await setInvoicePaymentStatus(accessToken, inv.id, opts.status);
  if (!r.ok) {
    console.error(`PUT /document/invoices/status failed (${r.status})`);
    console.error(r.bodyText.slice(0, 500));
    return 1;
  }

  // Verify by re-reading.
  const after = await listAllInvoices(accessToken, session.organization_id);
  const updated = after.ok ? after.data.find((d) => d.id === inv.id) : undefined;
  const confirmed = updated?.paymentStatus === opts.status;

  console.error(
    `${label}: ${inv.paymentStatus ?? "?"} -> ${updated?.paymentStatus ?? opts.status}` +
      (confirmed ? " ✓" : " (unverified)"),
  );
  if (opts.json && updated) console.log(JSON.stringify(updated, null, 2));
  return confirmed ? 0 : 1;
}
