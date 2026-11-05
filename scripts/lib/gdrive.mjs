// Read manuscripts from Google Drive with a service account (free).
//
// GOOGLE_SERVICE_ACCOUNT_JSON = the key file of a Google Cloud service account
// that the manuscripts folder is shared with (Commenter, so comments = captions
// are included). Only reads; never changes anything in Drive.
import crypto from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE = "https://www.googleapis.com/drive/v3";

export const driveEnabled = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

let token = null;
const b64url = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function key() {
  let k;
  try { k = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON. Paste the whole key file into the secret.");
  }
  if (!k.client_email || !k.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  return k;
}

export const serviceAccountEmail = () => key().client_email;

async function accessToken() {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const k = key();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: k.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(k.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function get(url, { text = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (res.ok) return text ? res.text() : res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).error.message; } catch {}
    throw new Error(`Google Drive ${res.status}: ${msg}`);
  }
}

const ALL = "supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives";

/** Every Google Doc the service account can see (the shared manuscripts folder), newest first. */
export async function listDocs({ modifiedAfter } = {}) {
  const q = ["mimeType='application/vnd.google-apps.document'", "trashed=false"];
  if (modifiedAfter) q.push(`modifiedTime > '${new Date(modifiedAfter).toISOString()}'`);
  const out = [];
  let page = "";
  do {
    const j = await get(`${DRIVE}/files?${ALL}&pageSize=1000&orderBy=modifiedTime desc&fields=nextPageToken,files(id,name,modifiedTime,parents,webViewLink)&q=${encodeURIComponent(q.join(" and "))}${page ? `&pageToken=${page}` : ""}`);
    out.push(...(j.files || []));
    page = j.nextPageToken || "";
  } while (page);
  return out;
}

const names = new Map();
/** Name of a folder (e.g. the author's folder a manuscript sits in). */
export async function folderName(id) {
  if (!id) return "";
  if (!names.has(id)) {
    names.set(id, get(`${DRIVE}/files/${id}?supportsAllDrives=true&fields=name`).then((j) => j.name || "").catch(() => ""));
  }
  return names.get(id);
}

/** A Google Doc as HTML (text, headings, lists, and comments = image captions). */
export async function exportHtml(id) {
  return get(`${DRIVE}/files/${id}/export?mimeType=text/html`, { text: true });
}
