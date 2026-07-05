import { writeFile, mkdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { ensureAccessToken } from "../../lib/auth.ts";
import {
  listAllPeppolDocuments,
  downloadPeppolDocumentUbl,
  type PeppolDocumentListItem,
} from "../../lib/api.ts";
import { extractEmbeddedPdf } from "../../lib/ubl.ts";
import { renderUblXmlToPdf } from "../../lib/ubl-render.ts";
import { buildBasename, uniqueBasename } from "../../lib/naming.ts";
import { loadManifest, saveManifest } from "../../lib/manifest.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function renamePair(
  dir: string,
  oldBase: string,
  newBase: string,
): Promise<void> {
  for (const ext of ["xml", "pdf"]) {
    const oldPath = join(dir, `${oldBase}.${ext}`);
    const newPath = join(dir, `${newBase}.${ext}`);
    if (oldPath === newPath) continue;
    if (await fileExists(oldPath)) {
      await rename(oldPath, newPath);
    }
  }
}

type Options = {
  out: string;
  since?: string;
  sender?: string;
  extractPdf: boolean;
  skipExisting: boolean;
};

async function writePdfForXml(
  xmlBytes: Uint8Array,
  pdfPath: string,
): Promise<{ embedded: boolean; filename: string | null }> {
  const xmlText = new TextDecoder("utf-8").decode(xmlBytes);
  const embedded = extractEmbeddedPdf(xmlText);
  if (embedded) {
    await writeFile(pdfPath, embedded.bytes);
    return { embedded: true, filename: embedded.filename };
  }
  const rendered = await renderUblXmlToPdf(xmlText);
  await writeFile(pdfPath, rendered);
  return { embedded: false, filename: null };
}

function parseArgs(args: string[]): Options {
  const opts: Partial<Options> = { extractPdf: false, skipExisting: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out" || a === "-o") opts.out = args[++i];
    else if (a === "--since") opts.since = args[++i];
    else if (a === "--sender") opts.sender = args[++i];
    else if (a === "--extract-pdf") opts.extractPdf = true;
    else if (a === "--force") opts.skipExisting = false;
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
  return opts as Options;
}

function printHelp(): void {
  console.log(`Usage: falcio peppol sync --out <dir> [--since YYYY-MM-DD] [--sender <vat>] [--extract-pdf] [--force]

Download every matching inbound Peppol document into <dir> as "<id>.xml".
Existing files are skipped by default (use --force to re-download).

When --extract-pdf is set, "<id>.pdf" is also written for every document:
  - if the UBL contains an embedded PDF rendition, it is extracted verbatim;
  - otherwise a PDF is rendered from the UBL by this CLI.

Options:
  --out <dir>          Target directory (created if missing). Required.
  --since YYYY-MM-DD   Keep only docs whose documentDate is on/after this date.
  --sender <vat>       Keep only docs whose supplierVatNumber/name contains <vat>.
  --extract-pdf        Ensure "<id>.pdf" exists for every document (extract or render).
  --force              Re-download even if "<id>.xml" already exists.`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runPeppolSync(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const { session, accessToken } = await ensureAccessToken();

  await mkdir(opts.out, { recursive: true });

  const r = await listAllPeppolDocuments(
    accessToken,
    session.organization_id,
    {},
    (page, newItems, total) => {
      console.error(`  [page ${page + 1}] +${newItems} (total so far: ${total})`);
    },
  );
  if (!r.ok) {
    console.error(`GET /peppol/documents failed (${r.status})`);
    console.error(r.bodyText.slice(0, 500));
    return 1;
  }

  let docs: PeppolDocumentListItem[] = r.data;
  if (opts.since) docs = docs.filter((d) => (d.documentDate ?? "").slice(0, 10) >= opts.since!);
  if (opts.sender) {
    const needle = opts.sender.toLowerCase();
    docs = docs.filter((d) =>
      (d.supplierVatNumber ?? "").toLowerCase().includes(needle) ||
      (d.supplierName ?? "").toLowerCase().includes(needle),
    );
  }

  if (docs.length === 0) {
    console.log("No matching documents.");
    return 0;
  }

  const manifest = await loadManifest(opts.out);
  const basenameToId = new Map<string, string>();
  for (const [id, base] of Object.entries(manifest.entries)) {
    basenameToId.set(base, id);
  }

  let wrote = 0;
  let skipped = 0;
  let renamed = 0;
  let pdfsEmbedded = 0;
  let pdfsRendered = 0;
  let failed = 0;

  for (const d of docs) {
    // Resolve the target basename for this document.
    let basename = manifest.entries[d.id];
    const proposed = buildBasename(d);
    if (!basename) {
      // New doc (or first run with manifest) — pick a basename, avoiding collisions
      // with entries we've already assigned in this run or to other ids.
      basename = uniqueBasename(proposed, (b) => {
        const other = basenameToId.get(b);
        return other !== undefined && other !== d.id;
      });
      manifest.entries[d.id] = basename;
      basenameToId.set(basename, d.id);
    } else {
      // Existing entry — recompute the target basename (with collision resolution)
      // and rename only if it actually differs from what's on disk.
      const target = uniqueBasename(proposed, (b) => {
        const other = basenameToId.get(b);
        return other !== undefined && other !== d.id;
      });
      if (target !== basename) {
        basenameToId.delete(basename);
        basenameToId.set(target, d.id);
        await renamePair(opts.out, basename, target);
        manifest.entries[d.id] = target;
        basename = target;
        renamed += 1;
      }
    }

    // One-shot migration: if a legacy file named "<uuid>.xml" is still present,
    // move it to the new basename.
    if (await fileExists(join(opts.out, `${d.id}.xml`))) {
      await renamePair(opts.out, d.id, basename);
      renamed += 1;
    }

    const xmlPath = join(opts.out, `${basename}.xml`);
    const pdfPath = join(opts.out, `${basename}.pdf`);
    const xmlExists = await fileExists(xmlPath);
    let xmlBytes: Uint8Array | null = null;

    if (opts.skipExisting && xmlExists) {
      skipped += 1;
      if (opts.extractPdf && !(await fileExists(pdfPath))) {
        xmlBytes = new Uint8Array(await Bun.file(xmlPath).arrayBuffer());
      } else {
        continue;
      }
    } else {
      const dl = await downloadPeppolDocumentUbl(accessToken, d.id);
      if (!dl.ok) {
        console.error(`  ✗ ${d.id} — HTTP ${dl.status}`);
        failed += 1;
        continue;
      }
      await writeFile(xmlPath, dl.bytes);
      wrote += 1;
      xmlBytes = dl.bytes;
      const label = `${d.documentDate?.slice(0, 10) ?? "?"}  ${d.supplierName ?? "?"}  ${d.amount ?? "?"} ${d.currency ?? ""}`;
      console.log(`  ✓ ${basename}  (${label})`);
    }

    if (opts.extractPdf && xmlBytes) {
      try {
        const res = await writePdfForXml(xmlBytes, pdfPath);
        if (res.embedded) pdfsEmbedded += 1;
        else pdfsRendered += 1;
      } catch (e) {
        console.error(`  ! ${basename} — PDF failed: ${(e as Error).message}`);
        failed += 1;
      }
    }
  }

  await saveManifest(opts.out, manifest);

  console.log(
    `\nDone: ${wrote} downloaded, ${skipped} already on disk, ${renamed} renamed, ` +
      `PDFs: ${pdfsEmbedded} extracted + ${pdfsRendered} rendered, ${failed} failed. ` +
      `Dir: ${opts.out}`,
  );
  return failed === 0 ? 0 : 1;
}
