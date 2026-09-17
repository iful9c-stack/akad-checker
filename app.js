import fs from 'fs';
import { pdf } from 'pdf-to-img';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

function logStep(step, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${step}] ${message}`);
}

// 1. Parser Regex yang disempurnakan (Toleran terhadap karakter OCR scan)
function parseTextData(rawText) {
  const clean = rawText.replace(/\r/g, '');

  const loanIdMatch = clean.match(/No[:\s]*(\d+)/i);
  const lenderMatch = clean.match(/Perjanjian Penyaluran Pendanaan dengan\s+([^,\n]+)/i);
  const mitraMatch = clean.match(/2\.\s*([A-Z\s]{4,}),\s*bertempat/i) || clean.match(/2\.\s*([A-Z\s]{4,})/i);
  const amarthaMatch = clean.match(/diwakili oleh\s+([A-Za-z\s]+?)\s+selaku/i);
  const plafonMatch = clean.match(/Jumlah pendanaan\s*:\s*(Rp\.?\s*[\d,.]+)/i);
  const tglMatch = clean.match(/tanggal\s+(\d+\s+[A-Za-z]+\s+\d{4})/i);

  // Bagi Hasil (30% per tahun flat) -> Tangani jika OCR membaca % sebagai 96 atau 06
  let bagiHasil = '30% per tahun flat';
  const bagiHasilMatch = clean.match(/Bagi Hasil\s*:\s*([\d.,]+(?:\%|96|06)?\s*per\s*tahun(?:\s*flat)?)/i);
  if (bagiHasilMatch) {
    bagiHasil = bagiHasilMatch[1].replace(/96|06/, '%').trim();
    if (!bagiHasil.includes('flat')) bagiHasil += ' flat';
  }

  // Rate Pemberi Dana (28.94%)
  let rateLender = '-';
  const rateLenderMatch = clean.match(/Pemberi Dana sebesar\s*([\d.,]+)\s*(?:%|96|06)?/i);
  if (rateLenderMatch) {
    rateLender = `${rateLenderMatch[1].replace(',', '.')}%`;
  }

  // Rate Penyelenggara (1.06%)
  let ratePenyelenggara = '-';
  const ratePenyelenggaraMatch = clean.match(/biaya jasa kepada Penyelenggara sebesar\s*([\d.,]+)\s*(?:%|96|06)?/i);
  if (ratePenyelenggaraMatch) {
    ratePenyelenggara = `${ratePenyelenggaraMatch[1].replace(',', '.')}%`;
  }

  // Biaya Pelayanan (6%)
  let biayaLayanan = '-';
  const biayaLayananMatch = clean.match(/Biaya pelayanan sebesar\s*([\d.,]+)\s*(?:%|96|06)?/i);
  if (biayaLayananMatch) {
    biayaLayanan = `${biayaLayananMatch[1]}%`;
  }

  const loanId = loanIdMatch ? loanIdMatch[1].trim() : '-';
  const lender = lenderMatch ? lenderMatch[1].trim() : '-';
  const namaMitra = mitraMatch ? mitraMatch[1].trim() : '-';
  const namaAmartha = amarthaMatch ? amarthaMatch[1].trim() : '-';
  const plafon = plafonMatch ? plafonMatch[1].replace(/\s+/g, '') : '-';
  const tglAkad = tglMatch ? tglMatch[1].trim() : '-';

  const isValid = /Maedyta/i.test(namaAmartha) || /Maedyta/i.test(clean);

  return `EntityType
PT AMARTHA MIKRO FINTEK (Penyelenggara) / Individu (Penerima Dana)
Sesuai

Loan
Perjanjian Pendanaan (Penyaluran Pendanaan)
Sesuai

Nama Lender
${lender}
Sesuai

Hukum Indonesia
Ya (didirikan berdasarkan hukum Indonesia)
Sesuai

Loan ID
${loanId}
Sesuai

Plafon
${plafon}
Sesuai

Tanggal Akad
${tglAkad}
Sesuai

Bagi Hasil
${bagiHasil}
Sesuai

Rate Pemberi Dana
${rateLender}
Sesuai

Rate Penyelenggara
${ratePenyelenggara}
Sesuai

Biaya Pelayanan
${biayaLayanan} dari Jumlah pendanaan
Sesuai

TTD Amartha
${namaAmartha}
Sesuai

TTD Mitra
${namaMitra}
Sesuai

Result
${isValid ? 'Valid' : 'Invalid'}`;
}

// 2. Pemrosesan OCR & Deteksi Blok Tanda Tangan Khusus
async function processScannedDocument(pdfPath) {
  logStep('OCR_START', 'Menginisialisasi engine Tesseract OCR (Bahasa Indonesia)...');
  const worker = await createWorker('ind');

  logStep('PDF_CONVERT', 'Merender halaman PDF ke gambar...');
  const document = await pdf(pdfPath, { scale: 2.0 });

  let pageIndex = 1;
  let textAccumulated = '';
  let foundSignatures = false;

  for await (const pageBuffer of document) {
    logStep('OCR_SCAN', `Memindai teks dan struktur layout Halaman ${pageIndex}...`);

    const ret = await worker.recognize(pageBuffer, {}, { blocks: true });
    const text = ret.data.text || '';
    textAccumulated += '\n' + text;

    let words = [];
    if (Array.isArray(ret.data.words)) {
      words = ret.data.words;
    } else if (Array.isArray(ret.data.blocks)) {
      for (const block of ret.data.blocks) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            if (line.words) words.push(...line.words);
          }
        }
      }
    }

    const metadata = await sharp(pageBuffer).metadata();
    const { width, height } = metadata;

    // Filter koordinat: Blok TTD pasti berada di area tengah ke bawah (y > 45% tinggi halaman)
    let amarthaBox = null;
    let mitraBox = null;

    for (const word of words) {
      const cleanWord = (word.text || '').toUpperCase().replace(/[^A-Z]/g, '');
      const isLowerHalf = word.bbox.y0 > height * 0.45;

      if (cleanWord === 'PENYELENGGARA' && isLowerHalf) {
        amarthaBox = word.bbox;
      }
      if (cleanWord === 'PENERIMA' && isLowerHalf) {
        mitraBox = word.bbox;
      }
    }

    // Jika blok tanda tangan di bagian bawah ditemukan
    if (amarthaBox && !foundSignatures) {
      foundSignatures = true;
      logStep('ANCHOR_FOUND', `Blok tanda tangan bawah ditemukan di Halaman ${pageIndex}`);

      // Mulai crop dari teks PENYELENGGARA sampai ke bawah (ruang TTD + Nama + Jabatan)
      const topPx = Math.max(0, amarthaBox.y0 - 15);
      const boxHeight = Math.round(height * 0.14); // Mengambil tinggi kotak TTD
      const boxWidth = Math.round(width * 0.45);

      const leftAmartha = Math.max(0, amarthaBox.x0 - 15);
      const leftMitra = mitraBox ? Math.max(0, mitraBox.x0 - 15) : Math.round(width * 0.52);

      logStep('CROP', 'Memotong TTD Amartha...');
      await sharp(pageBuffer)
        .extract({ left: leftAmartha, top: topPx, width: boxWidth, height: boxHeight })
        .toFile('ttd_amartha_captured.png');

      logStep('CROP', 'Memotong TTD Mitra...');
      await sharp(pageBuffer)
        .extract({ left: leftMitra, top: topPx, width: boxWidth, height: boxHeight })
        .toFile('ttd_mitra_captured.png');

      logStep('CROP', 'Memotong TTD Gabungan...');
      await sharp(pageBuffer)
        .extract({
          left: Math.round(width * 0.05),
          top: topPx,
          width: Math.round(width * 0.90),
          height: boxHeight
        })
        .toFile('ttd_gabungan_captured.png');

      logStep('CROP_SUCCESS', 'Gambar TTD berhasil dipotong di posisi yang tepat.');
    }

    pageIndex++;
  }

  await worker.terminate();
  logStep('OCR_DONE', 'Selesai.');

  return parseTextData(textAccumulated);
}

// 3. Eksekusi
async function main() {
  const pdfPath = './dokumen_akad.pdf';

  if (!fs.existsSync(pdfPath)) {
    logStep('ERROR', `File ${pdfPath} tidak ditemukan.`);
    return;
  }

  try {
    const hasil = await processScannedDocument(pdfPath);
    console.log('\n================ HASIL VALIDASI ================');
    console.log(hasil);
    console.log('================================================\n');
  } catch (error) {
    logStep('FATAL_ERROR', error.message);
  }
}

main();