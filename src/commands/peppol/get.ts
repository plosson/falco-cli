import { writeFile, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ensureAccessToken } from "../../lib/auth.ts";
import { downloadPeppolDocumentUbl } from "../../lib/api.ts";
import { extractEmbeddedPdf } from "../../lib/ubl.ts";
import { renderUblXmlToPdf } from "../../lib/ubl-render.ts";

type Options = {
  id: string;
  out?: string; // file path, directory, or "-" for stdout
  extractPdf: boolean;
};

function parseArgs(args: string[]): Options {
  const opts: Partial<Options> = { extractPdf: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out" || a === "-o") opts.out = args[++i];
    else if (a === "--extract-pdf") opts.extractPdf = true;
    else if (a === "-h" || a === "--help") {
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
    console.error("Expected exactly one argument: the document id (UUID).");
    printHelp();
    process.exit(1);
  }
  return { id: positional[0]!, out: opts.out, extractPdf: !!opts.extractPdf };
}

function printHelp(): void {
  console.log(`Usage: falco peppol get <id> [--out <file|dir|->] [--extract-pdf]

Download a single inbound Peppol document as UBL XML.

Positional:
  <id>   Document id (UUID), as listed by \`falco peppol list\`.

Options:
  --out <path>     Where to write the XML. Accepts:
                     - a file path (e.g. "./foo.xml")
                     - a directory path (will create "<dir>/<id>.xml")
                     - "-" for stdout
                   Default: "./<id>.xml" in the current directory.
  --extract-pdf    Also write "<same-base>.pdf" next to the XML (or "./<id>.pdf"
                   when writing to stdout).
                   - If the UBL contains an embedded PDF rendition, it's extracted
                     verbatim.
                   - Otherwise a PDF is rendered from the UBL by this CLI.`);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function runPeppolGet(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const { accessToken } = await ensureAccessToken();

  const r = await downloadPeppolDocumentUbl(accessToken, opts.id);
  if (!r.ok) {
    console.error(`GET /peppol/document/${opts.id} failed (${r.status})`);
    console.error(r.bodyText.slice(0, 500));
    return 1;
  }

  const xmlBytes = r.bytes;
  const xmlText = new TextDecoder("utf-8").decode(xmlBytes);

  let xmlTargetPath: string | null = null; // null => stdout
  if (opts.out === "-") {
    process.stdout.write(xmlText);
    if (!xmlText.endsWith("\n")) process.stdout.write("\n");
  } else {
    let outPath: string;
    if (!opts.out) {
      outPath = `${opts.id}.xml`;
    } else if (await isDirectory(opts.out)) {
      outPath = join(opts.out, `${opts.id}.xml`);
    } else {
      outPath = opts.out;
      const parent = dirname(outPath);
      if (parent && parent !== ".") await mkdir(parent, { recursive: true });
    }
    await writeFile(outPath, xmlBytes);
    xmlTargetPath = outPath;
    console.error(`wrote ${outPath} (${xmlBytes.byteLength} bytes)`);
  }

  if (opts.extractPdf) {
    let pdfPath: string;
    if (xmlTargetPath) {
      pdfPath = xmlTargetPath.replace(/\.xml$/i, "") + ".pdf";
      if (pdfPath === xmlTargetPath) pdfPath = xmlTargetPath + ".pdf";
    } else {
      pdfPath = `${opts.id}.pdf`;
    }
    const embedded = extractEmbeddedPdf(xmlText);
    let bytes: Uint8Array;
    let source: string;
    if (embedded) {
      bytes = embedded.bytes;
      source = `extracted${embedded.filename ? ` [original name: ${embedded.filename}]` : ""}`;
    } else {
      bytes = await renderUblXmlToPdf(xmlText);
      source = "rendered from UBL";
    }
    await writeFile(pdfPath, bytes);
    console.error(`wrote ${pdfPath} (${bytes.byteLength} bytes, ${source})`);
  }
  return 0;
}
