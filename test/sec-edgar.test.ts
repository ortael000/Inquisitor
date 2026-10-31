import { test } from "node:test";
import assert from "node:assert/strict";
import { secEdgarCollector, secSelection } from "../src/sources/sec-edgar.js";
import { archiveRoot, documentPath, filingRows } from "../src/sources/sec/submissions.js";
import { detailDocuments, extractDocument, sgmlDocuments } from "../src/sources/sec/documents.js";
import { configuredSource } from "../src/coverage.js";
import { collect } from "../src/collection.js";
import { openDatabase } from "../src/database.js";
import { CollectionError } from "../src/errors.js";
import type { SecConfig } from "../src/config.js";
import type { ByteTransport } from "../src/sources/http.js";
import { sequenceRuntime } from "./helpers/source-fixtures.js";

const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" };
const accession = "0000320193-26-000018";
const root = archiveRoot("320193", accession);
process.env.SEC_TEST_USER_AGENT = "InquisitorTests tests@example.invalid";
const config: SecConfig = { enabled: true, auth: "none", symbols: ["AAPL"], ciks: { AAPL: "320193" }, userAgentEnv: "SEC_TEST_USER_AGENT",
  accessVerified: true, englishVerified: true, mappingVerified: true, pageSize: 1, maxPages: 100, maxItems: 1000,
  maxBytes: 1000000, timeoutMs: 1000, maxDocumentBytes: 100000, maxFilingBytes: 500000 };
const columns = { accessionNumber: [accession], filingDate: ["2026-10-01"], form: ["8-K"], primaryDocument: ["primary.htm"],
  acceptanceDateTime: ["2026-10-02T00:30:28.000Z"], reportDate: ["2026-09-30"], items: ["2.02,9.01"] };
const submission = { cik: "320193", name: "Example Issuer", filings: { recent: columns, files: [] } };
const detail = `<table summary="Document Format Files"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th></tr>
<tr><td>1</td><td>Current report</td><td><a href="primary.htm">primary</a></td><td>8-K</td></tr>
<tr><td>2</td><td>Release</td><td><a href="release.htm">release</a></td><td>EX-99.1</td></tr></table>`;
const html = `<html><head><title>Company results</title></head><body><ix:hidden>HIDDENXBRL</ix:hidden><div style="display:none">SECRET</div>
<h1>Company results</h1><p>Revenue rose 5%.</p><table><tr><td>Revenue</td><td>100</td></tr><tr><td>Profit</td><td>20</td></tr></table></body></html>`;
const code = (expected: string) => (error: unknown) => error instanceof CollectionError && error.code === expected;

function runtime(json: unknown[], documents: (string | Uint8Array | Error)[], requests: URL[] = []) {
  const base = sequenceRuntime(json, requests);
  const pending = [...documents];
  const bytesTransport: ByteTransport = async (url, headers, _timeout, maxBytes) => {
    requests.push(new URL(url));
    assert.equal(headers["User-Agent"], "InquisitorTests tests@example.invalid");
    assert.equal(headers.Authorization, undefined);
    assert.ok(pending.length, "Unexpected document request");
    const raw = pending.shift()!;
    if (raw instanceof Error) throw raw;
    const data = typeof raw === "string" ? Buffer.from(raw) : raw;
    if (data.length > maxBytes) throw new CollectionError("TOO_LARGE");
    return { data, bytes: data.length, mediaType: url.pathname.endsWith(".txt") ? "text/plain" : "text/html" };
  };
  return { ...base, bytesTransport, done() { base.assertDone(); assert.equal(pending.length, 0); } };
}

test("SEC downloads primary and typed exhibits, removes hidden facts, and preserves filing-date provenance", async () => {
  const requests: URL[] = [];
  const injected = runtime([submission], [detail, html, html], requests);
  const result = await secEdgarCollector(config, injected)(range);
  injected.done();
  assert.equal(result.length, 2);
  assert.equal(result[0].source, "sec_edgar");
  assert.equal(result[0].publishedDate, "2026-10-01");
  assert.equal(result[0].publicationPrecision, "day");
  assert.equal(result[0].publishedAtUtc, undefined);
  assert.equal(result[0].contentKind, "full");
  assert.doesNotMatch(result[0].content, /HIDDENXBRL|SECRET/);
  assert.match(result[0].content, /Revenue/);
  assert.match(result[0].content, /Profit/);
  assert.equal(result[0].metadata?.kind, "corporate_filing");
  assert.equal(result[0].metadata?.publicationBasis, "sec_filing_date");
  assert.equal(result[0].metadata?.details.acceptedRaw, columns.acceptanceDateTime[0]);
  assert.notEqual(result[0].providerArticleId, result[1].providerArticleId);
  assert.equal(result[1].metadata?.details.documentType, "EX-99.1");
  assert.equal(requests[0].href, "https://data.sec.gov/submissions/CIK0000320193.json");
  assert.equal(requests[1].href, new URL(`${accession}-index.html`, root).href);
});

test("SEC main/root history arrays, optional fields, strict lengths, safe paths, and viewer links", () => {
  assert.deepEqual(filingRows(submission), filingRows(columns));
  const optional = { ...columns, reportDate: undefined, items: undefined };
  assert.equal(filingRows(optional)[0].items, null);
  assert.throws(() => filingRows({ ...columns, filingDate: [] }), code("INCOMPLETE"));
  assert.throws(() => filingRows({ ...columns, acceptanceDateTime: [] }), code("INCOMPLETE"));
  for (const primary of ["../escape.htm", "https://evil.invalid/file.htm", "%2e%2e/escape.htm", "file.htm?key=x"]) {
    assert.throws(() => filingRows({ ...columns, primaryDocument: [primary] }), code("INCOMPLETE"));
  }
  assert.equal(filingRows({ ...columns, primaryDocument: ["xsl/file.xml"] })[0].primary, "xsl/file.xml");
  assert.equal(documentPath(root, `/ix?doc=${root.pathname}primary.htm`), "primary.htm");
  assert.throws(() => documentPath(root, "https://evil.invalid/a.htm"), code("INCOMPLETE"));
  assert.throws(() => documentPath(root, "sub/../primary.htm"), code("INCOMPLETE"));
  assert.equal(detailDocuments(detail, root)[1].type, "EX-99.1");
});

test("SEC resolves exact tickers, shares work by CIK, traverses root-shaped history, and caches discovery across days", async () => {
  const old = { ...columns, accessionNumber: ["0000320193-26-000017"], filingDate: ["2026-09-30"] };
  const main = { ...submission, filings: { recent: { ...columns, form: ["4"] }, files: [{ name: "history.json", filingFrom: "2026-09-01", filingTo: "2026-10-01" }] } };
  const requests: URL[] = [];
  const injected = runtime([{ a: { ticker: "GOOG", cik_str: 320193 }, b: { ticker: "GOOGL", cik_str: 320193 } }, main, old], [], requests);
  const source = secEdgarCollector({ ...config, symbols: ["GOOG", "GOOGL"], ciks: undefined }, injected);
  assert.deepEqual(await source(range), []);
  assert.deepEqual(await source(range), []);
  injected.done();
  assert.equal(requests.length, 3);
  for (const mappings of [{}, { a: { ticker: "GOOG", cik_str: 1 }, b: { ticker: "GOOG", cik_str: 2 } }]) {
    await assert.rejects(secEdgarCollector({ ...config, symbols: ["GOOG"], ciks: undefined }, runtime([mappings], []))(range), code("CONFIGURATION"));
  }
});

test("SEC falls back to complete submission SGML and preserves amendments and synthetic titles", async () => {
  const sgml = `<DOCUMENT>\n<TYPE>8-K/A\n<SEQUENCE>1\n<FILENAME>primary.htm\n<TEXT><p>Amended financial statement.</p></TEXT>\n</DOCUMENT>
<DOCUMENT>\n<TYPE>EX-99.2\n<SEQUENCE>2\n<FILENAME>exhibit.txt\n<TEXT>Issuer announcement with corrected figures.</TEXT>\n</DOCUMENT>`;
  const injected = runtime([{ ...submission, filings: { recent: { ...columns, form: ["8-K/A"] }, files: [] } }], ["<html>No table</html>", sgml]);
  const result = await secEdgarCollector(config, injected)(range);
  injected.done();
  assert.equal(result.length, 2);
  assert.equal(result[0].metadata?.details.syntheticTitle, true);
  assert.match(result[0].title, /8-K\/A/);
  assert.equal(result[1].metadata?.details.selectionMethod, "submission_sgml");
  assert.equal(sgmlDocuments(sgml).length, 2);
});

test("SEC rejects partial ranges, missing identity, traversal, incomplete documents, denial, and byte limits", async () => {
  await assert.rejects(secEdgarCollector(config, runtime([], []))({ ...range, from: "2026-10-01T01:00:00Z" }), code("UNSUPPORTED_RANGE"));
  await assert.rejects(secEdgarCollector({ ...config, userAgentEnv: "MISSING_SEC_IDENTITY" }, runtime([], []))(range), code("CONFIGURATION"));
  await assert.rejects(secEdgarCollector({ ...config, requestIntervalMs: 100 }, runtime([], []))(range), code("CONFIGURATION"));
  await assert.rejects(secEdgarCollector(config, runtime([{ ...submission, cik: "1" }], []))(range), code("INCOMPLETE"));
  await assert.rejects(secEdgarCollector(config, runtime([{ ...submission, filings: { recent: columns, files: [{ name: "../bad.json" }] } }], []))(range), code("INCOMPLETE"));
  await assert.rejects(secEdgarCollector(config, runtime([submission], [detail, html, new CollectionError("ENTITLEMENT")]))(range), code("ENTITLEMENT"));
  await assert.rejects(secEdgarCollector({ ...config, includeExhibits: false }, runtime([submission], ["<title>Access Denied</title>"]))(range), code("ENTITLEMENT"));
  await assert.rejects(secEdgarCollector({ ...config, includeExhibits: false, maxDocumentBytes: 5 }, runtime([submission], [html]))(range), code("TOO_LARGE"));
});

test("SEC complete and zero-document days share daily coverage; failed extraction cannot mark coverage", async () => {
  const db = openDatabase(":memory:", true);
  try {
    const injected = runtime([submission], [html]);
    const settings = { ...config, includeExhibits: false };
    const source = configuredSource("sec_edgar", settings, c => secEdgarCollector(c, injected), 1, secSelection);
    const statuses: string[] = [];
    const options = { now: () => new Date("2026-10-19T00:00:00Z"), report: (s: {status:string}) => statuses.push(s.status) };
    await collect(db, [source], range, options);
    await collect(db, [source], range, options);
    assert.deepEqual(statuses, ["completed", "skipped"]);
    const row = db.prepare("SELECT * FROM articles").get()!;
    assert.equal(JSON.parse(String(row.source_metadata_json)).publicationBasis, "sec_filing_date");
    const bad = configuredSource("sec_edgar", { ...settings, symbols: ["MSFT"], ciks: { MSFT: "320193" } },
      c => secEdgarCollector(c, runtime([submission], ["<html></html>"])), 1, secSelection);
    assert.equal((await collect(db, [bad], range, options)).failed, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM collection_coverage").get()!.n, 1);
    const empty = configuredSource("sec_edgar", { ...settings, forms: ["10-K"] },
      c => secEdgarCollector(c, runtime([submission], [])), 1, secSelection);
    await collect(db, [empty], range, options);
    await collect(db, [empty], range, options);
    assert.equal(statuses.at(-1), "skipped");
    assert.notEqual(source.coverageKey, empty.coverageKey);
  } finally { db.close(); }
});

function pdf(text: string): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : "";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}

test("SEC PDF extraction reads a real text layer and explicitly rejects an image-only/empty PDF", async () => {
  const result = await extractDocument(pdf("Revenue rose five percent."), "application/pdf", "release.pdf", 10);
  assert.match(result.content, /Revenue rose five percent/);
  assert.equal(result.method, "pdfjs-text-v1");
  await assert.rejects(extractDocument(pdf(""), "application/pdf", "scanned.pdf", 10), code("OCR_REQUIRED"));
  await assert.rejects(extractDocument(pdf("text"), "application/pdf", "release.pdf", 0), code("TOO_LARGE"));
});
