import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { extractFromPdf, FIELDS } from './lib/extractor.js';
import { fetchPdfFromAmartha, fileNameFromPath, extractFilePath, fetchLoanDetail, findDocLoaFile } from './lib/remote.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-load .env jika belum ter-load (misal di Vercel serverless)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {}
}

const DEFAULT_AI_KEY = 'sk-009776894202163a-1lh99d-40d458b2';
const DEFAULT_AI_BASE = 'http://77.237.238.127:20128/v1';
const DEFAULT_AI_MODEL = 'ag/gemini-3-flash';

const PORT = parseInt(process.env.PORT || '3200', 10);
const rawKeys = [
  ...String(process.env.AI_API_KEY || '').split(','),
  ...String(process.env.GEMINI_API_KEYS || '').split(','),
  ...String(process.env.GEMINI_API_KEY || '').split(','),
].map((k) => k.trim()).filter(Boolean);

const API_KEYS = rawKeys.length > 0 ? rawKeys : [DEFAULT_AI_KEY];
const MODEL = process.env.AI_MODEL || DEFAULT_AI_MODEL;
const GATEWAY = process.env.AMARTHA_GATEWAY || 'https://api-gw-krakend.amartha.id/file-storage/v1/new-signed-url';
const LOAN_QUERY_URL = process.env.AMARTHA_QUERY_URL || 'https://api-gw-krakend.amartha.id/loan-state-machine/v2/api/loans/query';
const LOAN_BASE = process.env.AMARTHA_LOAN_BASE || 'https://api-gw-krakend.amartha.id/loan-state-machine/v2/api/loans';
const MAX_FILES = parseInt(process.env.MAX_FILES || '20', 10);
const MAX_SIZE_MB = parseInt(process.env.MAX_SIZE_MB || '15', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);

const ON_VERCEL = !!process.env.VERCEL;
const SYNC_ONLY = ON_VERCEL || String(process.env.SYNC_ONLY || '') === '1';
const COOKIE_SECURE = ON_VERCEL || String(process.env.COOKIE_SECURE || '') === '1';

const LOAN_QUERY_BODY = {
  from: 0,
  size: 10,
  sort: [{ createdAt: { order: 'desc' } }],
  query: {
    bool: {
      must: [{ terms: { kind: ['NORMAL-FUSE', 'NORMAL-ALL', 'NORMAL-PRO', 'NORMAL-RESTRUCTURE', 'NORMAL-JAM', 'NORMAL-PASAR POLIS', 'NORMAL-PASPOL', 'NORMAL-ALLIANZ', 'NORMAL-PAS', 'NORMAL-RESIDUAL', 'NORMAL-', 'NORMAL-WO', 'NORMAL-JAMKRIDA', 'NORMAL-ASK', 'NORMAL', 'NORMAL-TAKAFUL', 'NORMAL-PRODIGI', 'NORMAL-JAMKRINDO', 'NORMAL-REHABILITATION', 'NORMAL-ASTAR', 'NORMAL-JAMRKIDA', 'NORMAL-ASKRINDO'] } }],
      filter: [{ match: { state: 'INVESTED' } }],
    },
  },
};

// ---------- Sesi login stateless (cookie berisi token JWT) ----------
function getSessionId(req) {
  const cookie = req.headers.cookie || '';
  const hit = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('akadSession='));
  if (!hit) return null;
  return decodeURIComponent(hit.slice('akadSession='.length)) || null;
}

function getSessionToken(req) {
  return getSessionId(req);
}

function sessionCookie(value, maxAgeSec) {
  return `akadSession=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${maxAgeSec ? `; Max-Age=${maxAgeSec}` : ''}${COOKIE_SECURE ? '; Secure' : ''}`;
}

function clearSession(res) {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
}

function parseJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function verifyAmarthaToken(token) {
  return fetch(LOAN_QUERY_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      origin: 'https://ngmis.amartha.id',
      referer: 'https://ngmis.amartha.id/',
    },
    body: JSON.stringify(LOAN_QUERY_BODY),
  });
}

const sessionInfo = (info) => ({
  name: info.name || null,
  email: info.preferred_username || info.email || null,
  exp: info.exp || null,
});

function fail(res, status, message) {
  res.status(status).json({ ok: false, message });
}

function requireQueryUrl(res) {
  if (!LOAN_QUERY_URL) {
    fail(res, 500, 'AMARTHA_QUERY_URL belum diatur di environment.');
    return false;
  }
  return true;
}

function requireGateway(res) {
  if (!GATEWAY) {
    fail(res, 500, 'AMARTHA_GATEWAY belum diatur di environment.');
    return false;
  }
  return true;
}

export function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_SIZE_MB * 1024 * 1024,
      files: MAX_FILES,
    },
  });

  app.get('/api/session', async (req, res) => {
    const token = getSessionToken(req);
    if (!token) return res.json({ ok: true, loggedIn: false });

    const info = parseJwtPayload(token) || {};

    if (info.exp && info.exp * 1000 <= Date.now()) {
      clearSession(res);
      return res.json({ ok: true, loggedIn: false });
    }

    if (!requireQueryUrl(res)) return res.json({ ok: true, loggedIn: true, ...sessionInfo(info) });

    try {
      const r = await verifyAmarthaToken(token);
      if (r.status === 401 || r.status === 403) {
        clearSession(res);
        return res.json({ ok: true, loggedIn: false });
      }
      return res.json({ ok: true, loggedIn: true, ...sessionInfo(info) });
    } catch {
      return res.json({ ok: true, loggedIn: true, ...sessionInfo(info) });
    }
  });

  app.post('/api/login', async (req, res) => {
    const token = String((req.body || {}).token || '').trim();
    if (!token) return fail(res, 400, 'Token belum diisi.');
    if (!requireQueryUrl(res)) return;

    try {
      const r = await verifyAmarthaToken(token);

      if (r.status === 401 || r.status === 403) {
        return fail(res, 401, 'Token tidak valid (unauthorized). Login gagal.');
      }
      if (!r.ok) {
        return fail(res, 502, `Gagal memverifikasi token (status ${r.status}).`);
      }

      res.setHeader('Set-Cookie', sessionCookie(token, 8 * 60 * 60));

      const info = parseJwtPayload(token) || {};
      return res.json({ ok: true, ...sessionInfo(info) });
    } catch (e) {
      return fail(res, 502, `Gagal terhubung ke server Amartha: ${e.message}`);
    }
  });

  app.post('/api/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  // ---------- Job processing / streaming (SSE) ----------
  const jobs = new Map();

  function emit(job, event) {
    const seq = job.seq++;
    event.__seq = seq;
    job.buffer.push(event);
    for (const listener of job.listeners) listener(event);
  }

  function createJob(tasks) {
    const job = {
      id: randomUUID(),
      tasks,
      results: [],
      errors: [],
      buffer: [],
      seq: 0,
      listeners: new Set(),
      done: false,
    };
    jobs.set(job.id, job);
    return job;
  }

  async function processJob(job) {
    emit(job, { type: 'start', total: job.tasks.length });

    const processTask = async ([index, task]) => {
      let filename = task.name;
      const stage = task.resolve
        ? 'Mengambil file Akad dari file storage Amartha...'
        : 'Ekstraksi data dengan AI...';
      emit(job, {
        type: 'file-start',
        index,
        total: job.tasks.length,
        filename,
        stage,
      });

      try {
        let buffer = task.buffer;
        if (task.resolve) {
          const resolved = await task.resolve();
          buffer = resolved.buffer;
          filename = resolved.filename || filename;
        }
        const doc = await extractFromPdf(API_KEYS, MODEL, buffer, filename, index);
        if (task.loanId) doc.loanId = task.loanId;
        job.results.push(doc);
        emit(job, { type: 'file-done', index, total: job.tasks.length, filename, result: doc });
      } catch (e) {
        const err = { filename, message: e.message };
        job.errors.push(err);
        emit(job, { type: 'file-error', index, total: job.tasks.length, filename, error: err });
      }
    };

    const entries = [...job.tasks.entries()];
    const concurrency = CONCURRENCY;
    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      await Promise.all(batch.map(processTask));
    }

    job.done = true;
    emit(job, { type: 'done', results: job.results, errors: job.errors, fields: FIELDS });
    setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
    return job;
  }

  app.get('/api/config', (_req, res) => {
    res.json({
      ok: true,
      hasKey: API_KEYS.length > 0,
      keyCount: API_KEYS.length,
      model: MODEL,
      maxFiles: MAX_FILES,
      maxSizeMB: MAX_SIZE_MB,
      expectedTTD: 'Maedyta Annafiandini',
      gateway: GATEWAY ? '(terisi)' : '(kosong)',
      configured: !!(GATEWAY && LOAN_QUERY_URL),
      streaming: !SYNC_ONLY,
    });
  });

  app.post('/api/extract', upload.array('files'), async (req, res) => {
    if (API_KEYS.length === 0) {
      return fail(res, 400, 'AI_API_KEY belum diatur. Set variabel lingkungan lalu restart server.');
    }

    const files = req.files || [];
    if (files.length === 0) {
      return fail(res, 400, 'Tidak ada file yang diunggah.');
    }

    const invalid = files.filter((f) => f.mimetype !== 'application/pdf' && !f.originalname.toLowerCase().endsWith('.pdf'));
    if (invalid.length > 0) {
      return fail(res, 400, `File bukan PDF: ${invalid.map((f) => f.originalname).join(', ')}`);
    }

    const tasks = files.map((f) => ({ name: f.originalname, buffer: f.buffer }));

    const job = createJob(tasks);
    const sync = SYNC_ONLY || req.query.sync === '1';

    if (sync) {
      await processJob(job);
      return res.json({ ok: true, fields: FIELDS, results: job.results, errors: job.errors });
    }

    res.json({ ok: true, jobId: job.id, fields: FIELDS });
    processJob(job).catch((e) => emit(job, { type: 'fatal', message: e.message }));
  });

  app.post('/api/extract-remote', async (req, res) => {
    if (API_KEYS.length === 0) {
      return fail(res, 400, 'AI_API_KEY belum diatur. Set variabel lingkungan lalu restart server.');
    }

    const { token, files } = req.body || {};
    const refs = (Array.isArray(files) ? files : []).map((f) => String(f).trim()).filter(Boolean);
    const useToken = (token && String(token).trim()) || getSessionToken(req) || '';

    if (!useToken) {
      return fail(res, 400, 'Belum login — token Amartha tidak ditemukan. Silakan login dulu.');
    }
    if (refs.length === 0) {
      return fail(res, 400, 'Tidak ada file URL yang dikirim.');
    }

    const tasks = refs.map((ref) => ({
      name: fileNameFromPath(extractFilePath(ref)),
      resolve: () => fetchPdfFromAmartha({ ref, token: useToken, gateway: GATEWAY }),
    }));

    const job = createJob(tasks);
    const sync = SYNC_ONLY || req.query.sync === '1' || req.body.sync === true;

    if (sync) {
      await processJob(job);
      return res.json({ ok: true, fields: FIELDS, results: job.results, errors: job.errors });
    }

    res.json({ ok: true, jobId: job.id, fields: FIELDS });
    processJob(job).catch((e) => emit(job, { type: 'fatal', message: e.message }));
  });

  app.post('/api/extract-loan', async (req, res) => {
    if (API_KEYS.length === 0) {
      return fail(res, 400, 'AI_API_KEY belum diatur. Set variabel lingkungan lalu restart server.');
    }

    const { loanIds } = req.body || {};
    const ids = (Array.isArray(loanIds) ? loanIds : []).map((s) => String(s).trim()).filter(Boolean);
    const token = getSessionToken(req);

    if (!token) {
      return fail(res, 400, 'Belum login — silakan login dulu.');
    }
    if (ids.length === 0) {
      return fail(res, 400, 'Loan ID kosong.');
    }
    if (!requireGateway(res)) return;

    const tasks = ids.map((id) => ({
      name: `Loan ${id}`,
      loanId: id,
      resolve: async () => {
        const { status, json } = await fetchLoanDetail({ loanId: id, token, base: LOAN_BASE });
        if (status !== 200 || !json || !json.data) {
          const msg = json && json.message ? String(json.message) : '';
          throw new Error(`Loan ${id} gagal dimuat (status ${status})${msg ? `: ${msg}` : '.'}`);
        }
        const file = findDocLoaFile(json);
        if (!file) {
          throw new Error('File akad tidak tersedia (doc-loa belum ada).');
        }
        return fetchPdfFromAmartha({ ref: file, token, gateway: GATEWAY });
      },
    }));

    const job = createJob(tasks);
    const sync = SYNC_ONLY || req.query.sync === '1' || req.body.sync === true;

    if (sync) {
      await processJob(job);
      return res.json({ ok: true, fields: FIELDS, results: job.results, errors: job.errors });
    }

    res.json({ ok: true, jobId: job.id, fields: FIELDS });
    processJob(job).catch((e) => emit(job, { type: 'fatal', message: e.message }));
  });

  app.get('/api/loans/:loanId/akad/file', async (req, res) => {
    const token = getSessionToken(req);
    if (!token) {
      return fail(res, 401, 'Belum login. Silakan login dulu.');
    }
    const loanId = String(req.params.loanId || '').trim();
    if (!loanId) {
      return fail(res, 400, 'Loan ID kosong.');
    }
    if (!requireGateway(res)) return;

    try {
      const { status, json } = await fetchLoanDetail({ loanId, token, base: LOAN_BASE });
      if (status !== 200 || !json || !json.data) {
        const msg = json && json.message ? String(json.message) : '';
        return fail(res, 502, `Loan ${loanId} gagal dimuat (status ${status})${msg ? `: ${msg}` : '.'}`);
      }
      const file = findDocLoaFile(json);
      if (!file) {
        return fail(res, 404, 'File akad tidak tersedia (doc-loa belum ada).');
      }
      const { buffer, filename } = await fetchPdfFromAmartha({ ref: file, token, gateway: GATEWAY });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buffer);
    } catch (e) {
      return fail(res, 502, `Gagal mengambil file akad: ${e.message}`);
    }
  });

  app.get('/api/jobs/:id/stream', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      return fail(res, 404, 'Job tidak ditemukan.');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const send = (event) => {
      const { __seq: _seq, ...payload } = event;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (event.type === 'done' || event.type === 'fatal') {
        res.end();
      }
    };
    const listener = (event) => send(event);

    const startSeq = job.seq;
    job.listeners.add(listener);
    job.buffer.forEach((event) => {
      if (event.__seq < startSeq) send(event);
    });

    req.on('close', () => {
      job.listeners.delete(listener);
    });
  });

  return app;
}

const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const app = buildApp();
  app.listen(PORT, () => {
    console.log(`[SERVER] Web app aktif di http://localhost:${PORT}`);
    console.log(`[SERVER] AI Model: ${MODEL}${API_KEYS.length ? ` | ${API_KEYS.length} API key terpasang` : ' (API key belum diatur!)'}`);
  });
}