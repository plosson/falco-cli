// Internal Falco API client (api.my-falco.be) — matches the flow used by the
// Electron desktop app. Not the Partner API.

export const AUTH_URL = "https://accounts.horus-software.be";
export const API_URL = "https://api.my-falco.be";
export const BILLING_API_URL = "https://horusapi-billing.azurewebsites.net";
export const BRAND = "falco";
export const LOGIN_SCOPES = ["myhorus", "billing", "falco", "oclaf"];
export const REFRESH_SCOPES = ["myhorus", "billing", "oclaf"];

export type LoginOk = {
  type: "success";
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
};

export type LoginResult =
  | LoginOk
  | { type: "two_factor_required" }
  | { type: "error"; error: string; status: number; details?: string };

export async function login(params: {
  username: string;
  password: string;
  twoFaCode?: string;
}): Promise<LoginResult> {
  const body = {
    userName: params.username,
    password: params.password,
    twoFaCode: params.twoFaCode ?? null,
    brand: BRAND,
    impersonate: null,
    scopes: LOGIN_SCOPES,
  };
  let resp: Response;
  try {
    resp = await fetch(`${AUTH_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      type: "error",
      error: "network_error",
      status: 0,
      details: e instanceof Error ? e.message : String(e),
    };
  }
  const text = await resp.text();
  if (resp.ok) {
    try {
      const data = JSON.parse(text) as Omit<LoginOk, "type">;
      return { type: "success", ...data };
    } catch {
      return { type: "error", error: "invalid_response", status: resp.status, details: text.slice(0, 500) };
    }
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (parsed.error === "two_factor_required") return { type: "two_factor_required" };
  return {
    type: "error",
    error: (parsed.error as string) ?? "unknown",
    status: resp.status,
    details: text.slice(0, 500),
  };
}

export type RefreshResult =
  | { type: "success"; access_token: string; refresh_token: string; expires_in: number; refresh_token_expires_in: number }
  | { type: "error"; status: number; details?: string };

export async function refresh(refreshToken: string): Promise<RefreshResult> {
  const fd = new FormData();
  fd.append("grant_type", "refresh_token");
  fd.append("scope", REFRESH_SCOPES.join(" "));
  fd.append("refresh_token", refreshToken);
  const resp = await fetch(`${AUTH_URL}/oauth2/token`, { method: "POST", body: fd });
  if (!resp.ok) {
    const details = await resp.text().catch(() => "");
    return { type: "error", status: resp.status, details: details.slice(0, 500) };
  }
  const data = (await resp.json()) as Record<string, unknown>;
  return {
    type: "success",
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string,
    expires_in: data.expires_in as number,
    refresh_token_expires_in: data.refresh_token_expires_in as number,
  };
}

export async function revoke(refreshToken: string): Promise<void> {
  try {
    await fetch(`${AUTH_URL}/revoke-refresh-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ RefreshToken: refreshToken }),
    });
  } catch {}
}

// --- Authenticated GET helpers ------------------------------------------------

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; contentType: string | null; bodyText: string };

export type BinaryResult =
  | { ok: true; status: number; contentType: string; bytes: Uint8Array }
  | { ok: false; status: number; contentType: string | null; bodyText: string };

async function authedRequest(
  accessToken: string,
  method: string,
  pathAndQuery: string,
): Promise<Response> {
  const url = new URL(API_URL + pathAndQuery);
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
}

export async function apiGet<T>(
  accessToken: string,
  pathAndQuery: string,
): Promise<ApiResult<T>> {
  const resp = await authedRequest(accessToken, "GET", pathAndQuery);
  const contentType = resp.headers.get("content-type");
  const text = await resp.text();
  if (resp.ok) {
    if (!text) return { ok: true, status: resp.status, data: null as unknown as T };
    try {
      return { ok: true, status: resp.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: false, status: resp.status, contentType, bodyText: text };
    }
  }
  return { ok: false, status: resp.status, contentType, bodyText: text };
}

export async function apiGetBinary(
  accessToken: string,
  pathAndQuery: string,
  acceptMime = "application/octet-stream",
): Promise<BinaryResult> {
  const url = new URL(API_URL + pathAndQuery);
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: acceptMime },
  });
  const contentType = resp.headers.get("content-type");
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, contentType, bodyText };
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return {
    ok: true,
    status: resp.status,
    contentType: contentType ?? "application/octet-stream",
    bytes,
  };
}

// --- Typed endpoint wrappers --------------------------------------------------

export type UserMe = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  language: string;
  organizations: Array<{
    id: string;
    name: string;
    vatNumber?: string | null;
    country?: string | null;
    mainProductCode?: string | null;
  }>;
};

export function getUserMe(accessToken: string): Promise<ApiResult<UserMe>> {
  return apiGet<UserMe>(accessToken, "/user/me");
}

export type PeppolDocumentFilters = {
  showNotImported?: boolean;
  showImported?: boolean;
  showProcessing?: boolean;
  showAccepted?: boolean;
  showRejected?: boolean;
  showNoResponse?: boolean;
  minDate?: string; // ISO
  maxDate?: string; // ISO
  selfBilling?: boolean;
  last?: string; // pagination cursor (last seen id)
};

const PEPPOL_LIST_DEFAULTS: Required<Omit<PeppolDocumentFilters, "minDate" | "maxDate" | "last">> = {
  showNotImported: true,
  showImported: true,
  showProcessing: true,
  showAccepted: true,
  showRejected: true,
  showNoResponse: true,
  selfBilling: false,
};

export type PeppolDocumentListItem = {
  id: string;
  companyName: string | null;
  documentNumber: string | null;
  creationDate: string | null;
  documentDate: string | null;
  dueDate: string | null;
  downloadDate: string | null;
  amount: string | null;
  currency: string | null;
  supplierVatNumber: string | null;
  supplierParticipant: string | null;
  supplierName: string | null;
  isCreditNote: boolean;
  invoiceReference: string | null;
  paymentReference: string | null;
  bankAccountNumber: string | null;
  doNotImport: boolean;
  importState: string | null;
  importDate: string | null;
  fiduciaryDocumentId: string | null;
  lastInvoiceResponse: unknown;
};

export function listPeppolDocuments(
  accessToken: string,
  orgId: string,
  filters: PeppolDocumentFilters = {},
): Promise<ApiResult<PeppolDocumentListItem[]>> {
  const merged = { ...PEPPOL_LIST_DEFAULTS, ...filters };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return apiGet<PeppolDocumentListItem[]>(
    accessToken,
    `/peppol/documents/${orgId}?${qs.toString()}`,
  );
}

/**
 * Walk the /peppol/documents/{orgId} cursor pagination (last=<uuid>) until
 * the server stops returning new items. Returns every document in the active
 * organization that matches `filters`, de-duplicated by id.
 */
export async function listAllPeppolDocuments(
  accessToken: string,
  orgId: string,
  filters: Omit<PeppolDocumentFilters, "last"> = {},
  onPage?: (page: number, newItems: number, totalSoFar: number) => void,
): Promise<ApiResult<PeppolDocumentListItem[]>> {
  const all: PeppolDocumentListItem[] = [];
  const seen = new Set<string>();
  let last: string | undefined;
  const MAX_PAGES = 500;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await listPeppolDocuments(accessToken, orgId, { ...filters, last });
    if (!r.ok) return r;
    const chunk = r.data;
    if (chunk.length === 0) break;
    let newInPage = 0;
    for (const d of chunk) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        all.push(d);
        newInPage += 1;
      }
    }
    onPage?.(page, newInPage, all.length);
    if (newInPage === 0) break;
    const oldest = chunk[chunk.length - 1];
    if (!oldest) break;
    last = oldest.id;
  }
  return { ok: true, status: 200, data: all };
}

// ---------- Billing (outgoing sales invoices) ---------------------------

export type BillingDocument = {
  Id: string;
  Type:
    | "Invoice"
    | "CreditNote"
    | "Estimate"
    | "Proforma"
    | "AdvancePayment"
    | string;
  DocumentNumber: number | null;
  CreationDate: string | null;
  SendDate: string | null;
  DueDate: string | null;
  CustomerId: string | null;
  CustomerName: string | null;
  ReceiverEmailAddress: string | null;
  ReceiverVatNumber: string | null;
  IntermediateAmount: string | null;
  FinalAmount: string | null;
  CurrencyCode: string | null;
  Status: string | null;
  PeppolStatus: string | null;
  PaymentStatus: string | null;
  Communication: string | null;
  CommunicationType: string | null;
  HasPdfError: boolean;
};

export type BillingDocumentListResponse = {
  BillingDocuments: BillingDocument[];
  TotalCount?: number;
  Count?: number;
};

export type ListBillingDocumentsFilters = {
  Invoices?: boolean;
  CreditNotes?: boolean;
  Estimates?: boolean;
  AdvancePayments?: boolean;
  Proformas?: boolean;
  Offset?: number;
  StartingDate?: Date;
  EndDate?: Date;
};

async function billingFetch(
  accessToken: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(BILLING_API_URL + path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }
  return fetch(url, { method, headers, body: bodyStr });
}

export async function listBillingDocuments(
  accessToken: string,
  orgId: string,
  filters: ListBillingDocumentsFilters = { Invoices: true, CreditNotes: true },
): Promise<ApiResult<BillingDocument[]>> {
  const body: Record<string, unknown> = {
    Invoices: !!filters.Invoices,
    CreditNotes: !!filters.CreditNotes,
    Estimates: !!filters.Estimates,
    AdvancePayments: !!filters.AdvancePayments,
    Proformas: !!filters.Proformas,
    Offset: filters.Offset ?? 0,
  };
  if (filters.StartingDate) {
    body.StartingDateDay = filters.StartingDate.getUTCDate();
    body.StartingDateMonth = filters.StartingDate.getUTCMonth() + 1;
    body.StartingDateYear = filters.StartingDate.getUTCFullYear();
  }
  if (filters.EndDate) {
    body.EndDateDay = filters.EndDate.getUTCDate();
    body.EndDateMonth = filters.EndDate.getUTCMonth() + 1;
    body.EndDateYear = filters.EndDate.getUTCFullYear();
  }
  const resp = await billingFetch(
    accessToken,
    "POST",
    `/api.billing/billing-documents/period/${encodeURIComponent(orgId)}`,
    body,
  );
  const contentType = resp.headers.get("content-type");
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, contentType, bodyText: text };
  }
  try {
    const parsed = JSON.parse(text) as BillingDocumentListResponse;
    return { ok: true, status: resp.status, data: parsed.BillingDocuments ?? [] };
  } catch {
    return { ok: false, status: resp.status, contentType, bodyText: text };
  }
}

/**
 * Download the PDF of a billing document (sales invoice / credit note / etc.).
 */
export async function downloadBillingDocumentPdf(
  accessToken: string,
  docId: string,
): Promise<BinaryResult> {
  const resp = await billingFetch(
    accessToken,
    "GET",
    `/api.billing/billing-documents/src/${encodeURIComponent(docId)}`,
  );
  const contentType = resp.headers.get("content-type") ?? "application/pdf";
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, contentType, bodyText };
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return { ok: true, status: resp.status, contentType, bytes };
}

export type InvoiceFile = {
  id: string;
  fileName: string;
  contentType: string;
  order: number;
  fileSize: number;
};

export type InvoiceListItem = {
  id: string;
  peppolInvoiceId: string | null;
  type: "PurchaseInvoice" | "PurchaseCreditNote" | "SaleInvoice" | "SaleCreditNote" | string;
  status: string | null;
  paymentStatus: string | null;
  peppolStatus: string | null;
  origin: string | null;
  createdAt: string | null;
  invoiceDate: string | null;
  invoiceDueDate: string | null;
  amount: string | null;
  invoiceCurrency: string | null;
  invoiceReference: string | null;
  paymentReference: string | null;
  bankAccountNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  customerName: string | null;
  name: string | null;
  category: string | null;
  fiduciaryId: string | null;
  fiduciaryStatus: string | null;
  files: InvoiceFile[];
};

export type ListInvoicesFilters = {
  take?: number;
  sortBy?: "createdAt" | "invoiceDate" | "amount" | "supplierName";
  sortDirection?: "asc" | "desc";
  last?: string;
};

export function listInvoices(
  accessToken: string,
  orgId: string,
  filters: ListInvoicesFilters = {},
): Promise<ApiResult<InvoiceListItem[]>> {
  const qs = new URLSearchParams({ organizationId: orgId });
  qs.set("take", String(filters.take ?? 200));
  qs.set("sortBy", filters.sortBy ?? "createdAt");
  qs.set("sortDirection", filters.sortDirection ?? "desc");
  if (filters.last) qs.set("last", filters.last);
  return apiGet<InvoiceListItem[]>(accessToken, `/document/invoices?${qs.toString()}`);
}

/**
 * Walk /document/invoices pagination until the server stops returning new items.
 */
export async function listAllInvoices(
  accessToken: string,
  orgId: string,
  onPage?: (page: number, newItems: number, totalSoFar: number) => void,
): Promise<ApiResult<InvoiceListItem[]>> {
  const all: InvoiceListItem[] = [];
  const seen = new Set<string>();
  let last: string | undefined;
  for (let page = 0; page < 500; page++) {
    const r = await listInvoices(accessToken, orgId, { take: 100, last });
    if (!r.ok) return r;
    const chunk = r.data;
    if (chunk.length === 0) break;
    let newInPage = 0;
    for (const d of chunk) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        all.push(d);
        newInPage += 1;
      }
    }
    onPage?.(page, newInPage, all.length);
    if (newInPage === 0) break;
    const oldest = chunk[chunk.length - 1];
    if (!oldest) break;
    last = oldest.id;
  }
  return { ok: true, status: 200, data: all };
}

// Manually flip the payment status of a purchase/sale invoice. This is the only
// write the desktop app makes against this field for a standalone (non-fiduciary)
// Falco account: PUT /document/invoices/status with { DocumentId, PaymentStatus }.
// `DocumentId` is the InvoiceListItem.id (NOT the peppol document id).
export type InvoicePaymentStatus = "Paid" | "NotPaid";

export async function setInvoicePaymentStatus(
  accessToken: string,
  documentId: string,
  status: InvoicePaymentStatus,
): Promise<ApiResult<null>> {
  const url = new URL(API_URL + "/document/invoices/status");
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ DocumentId: documentId, PaymentStatus: status }),
  });
  const contentType = resp.headers.get("content-type");
  const text = await resp.text();
  if (resp.ok) return { ok: true, status: resp.status, data: null };
  return { ok: false, status: resp.status, contentType, bodyText: text };
}

// The /peppol/document/{id} endpoint serves the raw UBL XML, not JSON.
export function downloadPeppolDocumentUbl(
  accessToken: string,
  documentId: string,
): Promise<BinaryResult> {
  return apiGetBinary(
    accessToken,
    `/peppol/document/${documentId}`,
    "application/xml",
  );
}
