# Validator Akad — Data Ops

Web app validasi dokumen akad (perjanjian pendanaan Amartha). Login dengan token Bearer, masukkan Loan ID, sistem mengambil file akad (`doc-loa`), mengekstrak isinya dengan Google Gemini, lalu menilai dokumen Valid/Invalid.

## Cara menjalankan lokal

```bash
npm install
cp .env.example .env   # isi nilai environment Anda
npm run dev            # atau: node --env-file-if-exists=.env server.js
```

Buka `http://localhost:3000`.

## Variabel lingkungan

| Variabel | Keterangan |
| --- | --- |
| `GEMINI_API_KEYS` | Daftar API key Gemini, dipisah koma |
| `GEMINI_MODEL` | Model Gemini (default `gemini-3.6-flash`) |
| `AMARTHA_GATEWAY` | Endpoint krakend untuk unduh file storage |
| `AMARTHA_QUERY_URL` | Endpoint query/verifikasi token login |
| `AMARTHA_LOAN_BASE` | Endpoint detail loan (`…/v2/api/loans`) |
| `SYNC_ONLY` | `1` untuk memaksa jalur sinkron (serverless) |
| `COOKIE_SECURE` | `1` untuk atribut `Secure` pada cookie |

## Deploy ke Vercel

1. Buat repo GitHub lalu hubungkan project di Vercel (framework **Other**, akar direktori: root).
2. Set semua variabel lingkungan di atas di dashboard Vercel (jangan commit `.env`).
3. `vercel.json` sudah menyiapkan: file `public/` dilayani statis, semua rute lain diteruskan ke `api/index.js` (funfsi serverless Express).

Catatan serverless:
- Di Vercel sesi dibuat **stateless** — token langsung disimpan di cookie `akadSession` (HttpOnly, Secure).
- Mode **sinkron** dipakai otomatis (`SYNC_ONLY`), sehingga tidak ada SSE/job in-memory.
- Batas durasi fungsi berlaku; gunakan batch Loan ID secukupnya.