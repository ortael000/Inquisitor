/** SEC filing identities, safe archive paths, and submissions/history row parsing. */
import { CollectionError } from "../../errors.js";
import { validDay } from "../../normalize.js";
import { record } from "../http.js";

export interface Filing {
  accession: string;
  day: string;
  form: string;
  primary: string;
  reportDate: string | null;
  acceptedRaw: string | null;
  items: string | null;
}

export function cik(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d{1,10}$/.test(text) || /^0+$/.test(text)) throw new CollectionError("CONFIGURATION");
  return text.padStart(10, "0");
}

export function safePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.split("/").some(part =>
    !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) throw new CollectionError("INCOMPLETE");
  return value;
}

export function archiveRoot(issuer: string, accession: string): URL {
  if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw new CollectionError("INCOMPLETE");
  return new URL(`https://www.sec.gov/Archives/edgar/data/${Number(cik(issuer))}/${accession.replace(/-/g, "")}/`);
}

/** Accept direct paths or SEC's viewer links, but fetch only the direct filing document. */
export function documentPath(root: URL, href: string): string {
  let url: URL;
  try {
    url = new URL(href, root);
    if (url.origin === root.origin && ["/ix", "/ixviewer/ix.html"].includes(url.pathname)) {
      url = new URL(url.searchParams.get("doc") ?? "", root.origin);
    }
  } catch { throw new CollectionError("INCOMPLETE"); }
  if (!url.href.startsWith(root.href) || url.search || url.hash) throw new CollectionError("INCOMPLETE");
  // Validate raw href too: URL normalization must not conceal traversal.
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|\\/i.test(href)) throw new CollectionError("INCOMPLETE");
  return safePath(url.pathname.slice(root.pathname.length));
}

export function filingRows(payload: unknown): Filing[] {
  const response = record(payload);
  const columns = record(response.filings ? record(response.filings).recent : response);
  const ids = columns.accessionNumber;
  if (!Array.isArray(ids)) throw new CollectionError("INCOMPLETE");
  for (const field of ["filingDate", "form", "primaryDocument"]) {
    if (!Array.isArray(columns[field]) || columns[field].length !== ids.length) throw new CollectionError("INCOMPLETE");
  }
  for (const field of ["reportDate", "acceptanceDateTime", "items"]) {
    if (columns[field] !== undefined && (!Array.isArray(columns[field]) || columns[field].length !== ids.length)) {
      throw new CollectionError("INCOMPLETE");
    }
  }
  const optional = (field: string, index: number): string | null => {
    const value = columns[field]?.[index];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new CollectionError("INCOMPLETE");
    return value;
  };
  return ids.map((accession, i) => {
    if (typeof accession !== "string" || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
      || typeof columns.filingDate[i] !== "string" || !validDay(columns.filingDate[i])
      || typeof columns.form[i] !== "string" || !columns.form[i].trim()) throw new CollectionError("INCOMPLETE");
    return { accession, day: columns.filingDate[i], form: columns.form[i], primary: safePath(columns.primaryDocument[i]),
      reportDate: optional("reportDate", i), acceptedRaw: optional("acceptanceDateTime", i), items: optional("items", i) };
  });
}
