import path from 'path';

const PDF_MAGIC = Buffer.from('%PDF-');

function looksLikePdf(buf) {
  return buf.length >= 5 && buf.subarray(0, 5).equals(PDF_MAGIC);
}

function findDownloadUrl(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node)) return node;
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDownloadUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node);
    for (const key of keys) {
      if (/url|link|href|signed/i.test(key) && typeof node[key] === 'string' && /^https?:\/\//i.test(node[key])) {
        return node[key];
      }
    }
    for (const key of keys) {
      const found = findDownloadUrl(node[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function extractFilePath(ref) {
  if (/^https?:\/\//i.test(ref)) {
    try {
      const u = new URL(ref);
      const fileParam = u.searchParams.get('file');
      if (fileParam) return fileParam;
    } catch {
      /* lanjut fallback */
    }
  }
  return ref;
}

export function fileNameFromPath(filePath) {
  const cleaned = filePath.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path.basename(cleaned) || 'dokumen.pdf';
}

const LOAN_BASE = process.env.AMARTHA_LOAN_BASE || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchLoanDetail({ loanId, token, base }) {
  const baseUrl = (base || LOAN_BASE || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('AMARTHA_LOAN_BASE belum diatur di environment.');
  const url = `${baseUrl}/${encodeURIComponent(String(loanId))}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      origin: 'https://ngmis.amartha.id',
      referer: 'https://ngmis.amartha.id/',
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* respons bukan JSON */
  }
  return { status: res.status, json };
}

export function findDocLoaFile(loanJson) {
  try {
    const docs = loanJson?.data?.docs || [];
    const doc = docs.find((d) => d && d.type === 'doc-loa' && d.signedUrl);
    if (!doc) return null;
    const url = String(doc.signedUrl);
    const m = url.match(/[?&]file=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    return null;
  } catch {
    return null;
  }
}

export async function fetchPdfFromAmartha({ ref, token, gateway, attempts = 3 }) {
  const filePath = extractFilePath(ref);
  const gatewayUrl = new URL(gateway);
  gatewayUrl.searchParams.set('file', filePath);

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(gatewayUrl.toString(), {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json, text/plain, */*',
        },
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error(`Gateway ${res.status} ${res.statusText} untuk ${ref}`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`Gateway ${res.status} ${res.statusText} untuk ${ref}`);
      }
      if (!res.ok) {
        throw new Error(`Gateway ${res.status} ${res.statusText} untuk ${ref}`);
      }

      const contentType = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());

      if (looksLikePdf(buf)) {
        return { buffer: buf, filename: fileNameFromPath(filePath) };
      }

      // Fallback: respons JSON yang berisi URL unduhan
      let body;
      try {
        body = JSON.parse(buf.toString('utf8'));
      } catch {
        throw new Error(`Respons tidak dikenali (bukan PDF/JSON) untuk ${ref}`);
      }

      if (contentType.includes('json') || body) {
        const downloadUrl = findDownloadUrl(body);
        if (downloadUrl) {
          const dl = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
          if (!dl.ok) throw new Error(`Unduh PDF ${dl.status} ${dl.statusText}`);
          const pdfBuf = Buffer.from(await dl.arrayBuffer());
          if (!looksLikePdf(pdfBuf)) throw new Error('Unduhan bukan file PDF');
          return { buffer: pdfBuf, filename: fileNameFromPath(filePath) };
        }
      }

      throw new Error(`Signed URL tidak ditemukan di respons untuk ${ref}`);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const backoff = 400 * (i + 1);
        const httpStatus = e && e.message && /Gateway (\d{3})/.exec(e.message) && parseInt(/Gateway (\d{3})/.exec(e.message)[1], 10);
        if (httpStatus === 429 || httpStatus === 503) await sleep(1000 * (i + 1));
        else await sleep(backoff);
      }
    }
  }

  if (lastErr && /Gateway (\d{3})/.test(lastErr.message)) {
    const status = parseInt(/Gateway (\d{3})/.exec(lastErr.message)[1], 10);
    if (status === 429 || status >= 500) {
      throw new Error(`Gateway masih gagal setelah ${attempts} percobaan (${status}). Coba lagi.`);
    }
  }
  throw lastErr || new Error(`Gagal mengambil file untuk ${ref}`);
}