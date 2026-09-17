import { GoogleGenerativeAI } from '@google/generative-ai';

export const FIELDS = [
  { key: 'Entity', label: 'Entity' },
  { key: 'TypeLoan', label: 'Type Loan' },
  { key: 'NamaLender', label: 'Nama Lender' },
  { key: 'HukumIndonesia', label: 'Hukum Indonesia' },
  { key: 'LoanID', label: 'Loan ID' },
  { key: 'Plafon', label: 'Plafon' },
  { key: 'TanggalAkad', label: 'Tanggal Akad' },
  { key: 'BagiHasil', label: 'Bagi Hasil' },
  { key: 'RatePemberiDana', label: 'Rate Pemberi Dana' },
  { key: 'RatePenyelenggara', label: 'Rate Penyelenggara' },
  { key: 'BiayaPelayanan', label: 'Biaya Pelayanan' },
  { key: 'TTDAmartha', label: 'TTD Amartha' },
  { key: 'TTDMitra', label: 'TTD Mitra' },
];

const EXPEXTED_TTD_AMARTHA = 'maedyta annafiandini';

const PROMPT = `Anda adalah validator dokumen perjanjian pendanaan (akad) fintech Indonesia.

Analisis dokumen PDF ini secara menyeluruh (semua halaman). Jika dokumen tidak terbaca atau bukan dokumen akad yang valid, isi field terkait dengan string kosong.

Kembalikan HANYA satu objek JSON (tanpa markdown/teks lain). Skema:
{
  "Entity": "...",            // Para pihak, mis. "PT AMARTHA MIKRO FINTEK (Penyelenggara) / {nama} (Penerima Dana)"
  "TypeLoan": "...",          // Jenis perjanjian, mis. "Perjanjian Pendanaan - Syarat Khusus" atau "Perjanjian Pendanaan"
  "NamaLender": "...",        // Nama Pemberi Dana / Lender yang menyalurkan dana (isikan nama lengkap, "-" jika tidak ada)
  "HukumIndonesia": "...",    // "Ya" jika perjanjian tunduk pada hukum Indonesia, selain itu isi "-"
  "LoanID": "...",            // Nomor perjanjian / Loan ID, mis. "10996925"
  "Plafon": "...",            // Jumlah pendanaan, mis. "Rp. 8.000.000"
  "TanggalAkad": "...",       // Tanggal efektif / tanggal akad, mis. "7 September 2026"
  "BagiHasil": "...",         // mis. "30% per tahun flat"
  "RatePemberiDana": "...",   // mis. "28.94%"
  "RatePenyelenggara": "...", // mis. "1.06%"
  "BiayaPelayanan": "...",    // mis. "6% dari Jumlah pendanaan"
  "TTDAmartha": "...",        // Nama pada blok tanda tangan PENYELENGGARA / TTD Amartha (perhatikan blok "Nama:" pada area tanda tangan), "-" jika kosong
  "TTDMitra": "...",          // Nama pada blok tanda tangan PENERIMA DANA / Mitra, "-" jika kosong
  "isPhoto": true/false       // true jika file ini adalah foto/pindaian (scan) gambar dokumen, false jika dokumen digital asli yang berisi teks
}

Aturan penting:
- Jika suatu nilai tidak dapat dibaca / tidak ada / kosong, gunakan "-" (bukan mengarang).
- TTD diambil dari bagian akhir dokumen pada area "PENYELENGGARA" dan "PENERIMA DANA".
- TTD Amartha adalah tanda tangan pihak Penyelenggara (PT Amartha Mikro Fintek), bukan penerima dana.`;

function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/[^A-Za-z0-9 ,.()%+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompare(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isBlank(value) {
  const v = normalizeText(value).toLowerCase();
  if (!v) return true;
  return ['-', 'n/a', 'na', 'none', 'null', 'not found', 'tidak ada', 'tidak ditemukan', 'kosong', 'blank'].includes(v);
}

export function parseModelResponse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Respons model tidak berbentuk JSON');
  return JSON.parse(match[0]);
}

export function validateDocument(raw, filename = '') {
  const data = raw || {};
  const isPhoto = Boolean(data.isPhoto);
  const reasons = [];
  const invalidFields = [];

  for (const field of FIELDS) {
    if (isBlank(data[field.key])) {
      invalidFields.push(field.label);
    }
  }

  if (isPhoto) {
    reasons.push('Dokumen berupa foto/pindaian, bukan dokumen digital asli');
  }

  if (invalidFields.length > 0) {
    reasons.push(`Kolom kosong: ${invalidFields.join(', ')}`);
  }

  const ttdAmartha = normalizeCompare(data['TTDAmartha']);
  if (!ttdAmartha.includes('maedyta')) {
    reasons.push(`TTD Amartha ("${normalizeText(data['TTDAmartha'])}") bukan Maedyta Annafiandini`);
  }

  const isValid = reasons.length === 0;

  return {
    filename,
    raw: data,
    result: isValid ? 'Valid' : 'Invalid',
    reasons,
  };
}

export function extractData(result) {
  return {
    Entity: result.raw.Entity || '-',
    TypeLoan: result.raw.TypeLoan || '-',
    NamaLender: result.raw.NamaLender || '-',
    HukumIndonesia: result.raw.HukumIndonesia || '-',
    LoanID: result.raw.LoanID || '-',
    Plafon: result.raw.Plafon || '-',
    TanggalAkad: result.raw.TanggalAkad || '-',
    BagiHasil: result.raw.BagiHasil || '-',
    RatePemberiDana: result.raw.RatePemberiDana || '-',
    RatePenyelenggara: result.raw.RatePenyelenggara || '-',
    BiayaPelayanan: result.raw.BiayaPelayanan || '-',
    TTDAmartha: result.raw.TTDAmartha || '-',
    TTDMitra: result.raw.TTDMitra || '-',
  };
}

function isRetryableError(err) {
  return [
    '429', '500', '503', 'RESOURCE_EXHAUSTED',
    'UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'Service Unavailable',
    'rate limit', 'quota',
    'PERMISSION_DENIED', 'API_KEY_INVALID',
    'API key not valid',
  ].some((s) => (err.message || '').includes(s));
}

export async function extractFromPdf(apiKeys, modelName, buffer, filename, startKeyIndex = 0) {
  const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys].filter(Boolean);
  if (keys.length === 0) throw new Error('Tidak ada API key Gemini.');

  const base64 = buffer.toString('base64');
  const parts = [
    { inlineData: { mimeType: 'application/pdf', data: base64 } },
    PROMPT,
  ];

  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[(startKeyIndex + i) % keys.length];
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
      },
    });

    try {
      const result = await model.generateContent(parts);
      const text = result.response.text();
      let raw;
      try {
        raw = parseModelResponse(text);
      } catch (e) {
        const error = new Error(`Gagal parse respons Gemini: ${e.message}`);
        error.responsesText = text;
        throw error;
      }
      return validateDocument(raw, filename);
    } catch (err) {
      lastError = err;
      if (isRetryableError(err)) continue; // coba key berikutnya
      throw err;
    }
  }
  throw lastError;
}