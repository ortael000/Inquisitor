/** SEC document-table/SGML discovery and HTML, plain-text, or text-layer PDF extraction. */
import { load } from "cheerio";
import { CollectionError } from "../../errors.js";
import { plainText } from "../../normalize.js";
import { documentPath, safePath } from "./submissions.js";

export interface FilingDocument {
  path: string;
  type: string;
  sequence: string | null;
  description: string;
  inline?: string;
}

export function detailDocuments(html: string, root: URL): FilingDocument[] {
  const $ = load(html);
  const documents: FilingDocument[] = [];
  let found = false;
  $("table").each((_i, table) => {
    const headers = $(table).find("tr").first().find("th,td").map((_i, c) => $(c).text().trim().toLowerCase()).get();
    const type = headers.indexOf("type"), document = headers.indexOf("document");
    if (type < 0 || document < 0) return;
    found = true;
    $(table).find("tr").slice(1).each((_i, row) => {
      const cells = $(row).find("td");
      if (!cells.length) return;
      const kind = cells.eq(type).text().trim();
      // Data-file rows are not selected by the adapter, but still require a valid table shape.
      if (cells.length < headers.length) throw new CollectionError("INCOMPLETE");
      const href = cells.eq(document).find("a").attr("href");
      if (!href) throw new CollectionError("INCOMPLETE");
      documents.push({ path: documentPath(root, href), type: kind,
        sequence: headers.includes("seq") ? cells.eq(headers.indexOf("seq")).text().trim() || null : null,
        description: cells.eq(headers.indexOf("description")).text().trim() });
    });
  });
  if (!found || !documents.length) throw new CollectionError("INCOMPLETE");
  return documents;
}

export function sgmlDocuments(text: string): FilingDocument[] {
  const documents: FilingDocument[] = [];
  for (const match of text.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/gi)) {
    const block = match[1];
    const field = (name: string) => new RegExp(`^\\s*<${name}>([^\\r\\n<]+)`, "im").exec(block)?.[1].trim();
    const path = field("FILENAME"), type = field("TYPE");
    const body = /<TEXT>([\s\S]*?)(?:<\/TEXT>|$)/i.exec(block)?.[1];
    if (!path || !type || body === undefined) throw new CollectionError("INCOMPLETE");
    documents.push({ path: safePath(path), type, sequence: field("SEQUENCE") ?? null,
      description: field("DESCRIPTION") ?? "", inline: body });
  }
  if (!documents.length) throw new CollectionError("INCOMPLETE");
  return documents;
}

export async function extractDocument(data: Uint8Array, mediaType: string, path: string, maxPages: number) {
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 5).toString() === "%PDF-" || /application\/pdf/i.test(mediaType)) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, stopAtErrors: true, verbosity: 0 });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > maxPages) throw new CollectionError("TOO_LARGE");
      const pages: string[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let text = "", lastY: number | undefined;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const y = item.transform[5];
          text += (lastY !== undefined && lastY !== y ? "\n" : " ") + item.str;
          if (item.hasEOL) text += "\n";
          lastY = y;
        }
        pages.push(text.trim());
        page.cleanup();
      }
      const content = pages.join("\n\n").trim();
      if (!/[\p{L}\p{N}]/u.test(content)) throw new CollectionError("OCR_REQUIRED");
      return { content, title: "", method: "pdfjs-text-v1" };
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      throw new CollectionError("EXTRACTION");
    } finally { await task.destroy(); }
  }
  const prefix = bytes.subarray(0, 8192).toString("ascii");
  const encoding = /charset\s*=\s*["']?([\w-]+)/i.exec(mediaType)?.[1]
    ?? /(?:charset|encoding)\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] ?? "utf-8";
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(data); }
  catch { throw new CollectionError("EXTRACTION"); }
  if (/<DOCUMENT>/i.test(text)) {
    const documents = sgmlDocuments(text);
    const document = documents.find(d => d.path === path) ?? (documents.length === 1 ? documents[0] : undefined);
    if (!document) throw new CollectionError("EXTRACTION");
    text = document.inline!;
  }
  if (/\.(?:xml|html?|xhtml)$/i.test(path) || /text\/html/i.test(mediaType) || /<(?:html|body|p|table)\b/i.test(text)) {
    const $ = load(text);
    $("script,style,noscript,[hidden],[aria-hidden='true'],ix\\:hidden").remove();
    $("[style]").each((_i, el) => {
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr("style") ?? "")) $(el).remove();
    });
    const title = plainText($("h1").first().text() || $("title").first().text());
    return { content: plainText($.html()), title, method: "html-to-text-v1" };
  }
  if (!/\.txt$/i.test(path) && !/^text\/plain/i.test(mediaType)) throw new CollectionError("EXTRACTION");
  return { content: text.replace(/\r\n?/g, "\n").trim(), title: "", method: "plain-text-v1" };
}
