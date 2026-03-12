const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
require('dotenv').config();

const execFileAsync = promisify(execFile);

const app = express();
const port = process.env.PORT || 3000;
const gptModel = process.env.GPT_MODEL || 'gpt-4o';
const useReference = process.env.USE_REFERENCE !== '0' && process.env.USE_REFERENCE !== 'false';
const ean13Only = process.env.BARCODE_EAN13_ONLY === '1' || process.env.BARCODE_EAN13_ONLY === 'true';
const barcodeServiceUrl = process.env.BARCODE_SERVICE_URL || null;

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PDF'i URL'den indir
async function downloadPDF(url) {
  try {
    const response = await axios({
      url: url,
      method: 'GET',
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data);
  } catch (error) {
    throw new Error(`PDF indirme hatası: ${error.message}`);
  }
}

// PDF'i görüntüye çevir
// Linux: sistemdeki pdftoppm (poppler-utils) kullanır. Diğer platformlar: pdf-poppler.
// Linux'ta ayrıca tempPdfPath döner (pdftotext için); çağıran silmekle yükümlü.
async function convertPDFToImages(pdfBuffer) {
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const tempPdfPath = path.join(tempDir, `temp_${timestamp}.pdf`);
  const outPrefix = path.join(tempDir, `page_${timestamp}`);
  fs.writeFileSync(tempPdfPath, pdfBuffer);

  try {
    if (process.platform === 'linux') {
      // Linux: pdftoppm (poppler-utils) - kurulum: apt-get install poppler-utils
      await execFileAsync('pdftoppm', ['-png', tempPdfPath, outPrefix], { maxBuffer: 50 * 1024 * 1024 });
      const prefixBase = path.basename(outPrefix);
      const files = fs.readdirSync(tempDir);
      const imageFiles = files
        .filter(f => f.startsWith(prefixBase) && f.endsWith('.png'))
        .map(f => path.join(tempDir, f))
        .sort((a, b) => {
          const na = parseInt(path.basename(a).match(/-(\d+)\.png$/)?.[1] || '0', 10);
          const nb = parseInt(path.basename(b).match(/-(\d+)\.png$/)?.[1] || '0', 10);
          return na - nb;
        });
      // PDF'i silme; pdftotext için çağırana bırakıyoruz
      return { imagePaths: imageFiles, tempPdfPath };
    }

    // macOS: mümkünse sistemdeki pdftoppm (brew install poppler) ile sadece ilk sayfayı çevir
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('pdftoppm', ['-png', '-f', '1', '-l', '1', tempPdfPath, outPrefix], { maxBuffer: 50 * 1024 * 1024 });
        const prefixBase = path.basename(outPrefix);
        const files = fs.readdirSync(tempDir);
        const imageFiles = files
          .filter(f => f.startsWith(prefixBase) && f.endsWith('.png'))
          .map(f => path.join(tempDir, f))
          .sort();
        fs.unlinkSync(tempPdfPath);
        return imageFiles;
      } catch (e) {
        // pdftoppm yoksa pdf-poppler'a düş
        console.warn('macOS pdftoppm bulunamadı, pdf-poppler kullanılacak:', e.message);
      }
    }

    // Windows / macOS fallback: pdf-poppler
    const pdfPoppler = require('pdf-poppler');
    const options = {
      format: 'png',
      out_dir: tempDir,
      out_prefix: `page_${timestamp}`,
      // Büyük PDF'lerde hız için sadece ilk sayfayı çevir (GPT için genelde yeterli)
      page: 1,
    };
    await pdfPoppler.convert(tempPdfPath, options);
    const files = fs.readdirSync(tempDir);
    const imageFiles = files
      .filter(file => file.startsWith(options.out_prefix) && file.endsWith('.png'))
      .map(file => path.join(tempDir, file))
      .sort();
    fs.unlinkSync(tempPdfPath);
    return imageFiles;
  } catch (error) {
    if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
    if (process.platform === 'linux') {
      throw new Error(`PDF görüntüye çevirme hatası (pdftoppm). Sunucuda poppler-utils kurulu olmalı: apt-get install poppler-utils. ${error.message}`);
    }
    throw new Error(`PDF görüntüye çevirme hatası: ${error.message}`);
  }
}

// pdftotext + zbarimg ile deterministik analiz (Linux; poppler-utils + zbar-tools gerekir)
async function analyzePDFWithPdftools(tempPdfPath, imagePaths) {
  let referenceNumber = null;
  let barcode = null;

  try {
    // pdftotext: PDF'ten metin çıkar; ref "Code: P1LB1C07", "Item: P2SF1013 ..." veya tek başına "P2SF1013" olabilir
    const { stdout: textOut } = await execFileAsync('pdftotext', [tempPdfPath, '-'], { maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const text = textOut || '';
    const pCodeRegex = /\b(P[0-9][A-Za-z0-9]{4,})\b/g;
    // Öncelik 1: "Code: P1LB1C07" (Code: sonrası P-kodu)
    let refMatch = text.match(/Code:\s*(P[0-9][A-Za-z0-9]{4,})\b/i);
    if (refMatch) referenceNumber = refMatch[1].trim();
    else {
      // Öncelik 2: "Item: P1LB1C07_..." veya "Item: P2SF1013 ..."
      refMatch = text.match(/Item:\s*(P[0-9][A-Za-z0-9]{4,})/i);
      if (refMatch) referenceNumber = refMatch[1].trim();
      else {
        // Öncelik 3: metinde herhangi bir yerde geçen P-kodu (ilk eşleşen)
        refMatch = text.match(pCodeRegex);
        if (refMatch) referenceNumber = refMatch[0].trim();
      }
    }

    // zbarimg: her sayfa görüntüsünden barkod oku (EAN-13 veya tüm tipler)
    for (const imagePath of imagePaths) {
      const args = ean13Only ? ['-q', '--set', 'ean13.enable', imagePath] : ['-q', imagePath];
      try {
        const { stdout: zbarOut } = await execFileAsync('zbarimg', args, { encoding: 'utf8' });
        const lines = (zbarOut || '').trim().split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          // EAN-13:8056669925781 veya sadece 8056669925781
          const m = line.match(/^(?:EAN-13|EAN13)[:\s]*([0-9]+)/i) || (!ean13Only && line.match(/^(?:CODE-128|CODE128)[:\s]*([0-9]+)/i)) || line.match(/^([0-9]{8,14})$/);
          const num = m ? m[1] : null;
          if (!num || !/^[0-9]+$/.test(num)) continue;
          if (ean13Only && num.length !== 13) continue; // EAN-13 tam 13 hane
          barcode = num.replace(/\s/g, '');
          break;
        }
        if (barcode) break;
      } catch (_) {
        // Bu sayfada barkod yok veya zbar hata verdi, sonrakine geç
      }
    }
  } catch (err) {
    console.warn('pdftools analiz hatası:', err.message);
    return null;
  }

  return { barcode: barcode || null, referenceNumber: referenceNumber || null };
}

// Görüntüyü base64'e çevir
function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

// --- GPT ile analiz ---
async function askGPT(imageContents, systemPrompt, userPrompt) {
  const response = await openai.chat.completions.create({
    model: gptModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [{ type: 'text', text: userPrompt }, ...imageContents] },
    ],
    max_completion_tokens: 4096,
  });
  const content = response.choices[0].message.content || '';
  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
  const jsonString = jsonMatch ? jsonMatch[1] : content;
  try {
    return JSON.parse(jsonString.trim());
  } catch (_) {
    return {};
  }
}

// GPT ile PDF'i analiz et: önce sadece Ref, sonra sadece barkod (iki ayrı çağrı = karışma azalır)
async function analyzePDFWithGPT(imagePaths) {
  const imageContents = imagePaths.map(imagePath => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${imageToBase64(imagePath)}` },
  }));

  const refPrompt = `Bu görüntüler ambalaj artwork sayfaları. Görevin: SADECE "Ref:" veya "Ref." yazısının hemen yanında/altında yazan değeri bul.
- Bu değer genelde "P" ile başlar (örn. P1DO1101, P2SF1013). "DG" ile başlayan ürün kodu DEĞİL.
- Değer baş aşağı (180° dönük) yazılmış olabilir; o zaman düz okuma sırasına çevir.
- Barkod, ürün kodu veya başka numara VERME. Sadece Ref/Ref. etiketinin yanındaki değer.
- Bulamazsan null yaz. Sadece şu JSON'u döndür, başka metin yazma: {"referenceNumber": "değer veya null"}`;

  const barcodePrompt = `Bu görüntüler ambalaj artwork sayfaları. Görevin: SADECE barkod çizgilerinin altında/yanında yazan sayıyı bul (EAN/GTIN).
- Rakamlar ters basılmışsa düz sırada yaz (örn. 8056669927389). Boşluk kullanma.
- Sadece barkod numarası. Bulamazsan null. Sadece şu JSON'u döndür: {"barcode": "rakamlar veya null"}`;

  const [refResult, barcodeResult] = await Promise.all([
    askGPT(imageContents, 'Sen bir görüntü analizcisin. Sadece istenen JSON çıktısını ver, ek açıklama yapma.', refPrompt),
    askGPT(imageContents, 'Sen bir görüntü analizcisin. Sadece istenen JSON çıktısını ver, ek açıklama yapma.', barcodePrompt),
  ]);

  const referenceNumber = (refResult.referenceNumber && String(refResult.referenceNumber).trim()) || null;
  let barcode = (barcodeResult.barcode && String(barcodeResult.barcode).trim()) || null;
  if (barcode) barcode = barcode.replace(/\s/g, '');

  return { barcode, referenceNumber };
}

// Geçici dosyaları temizle
function cleanupTempFiles(imagePaths) {
  imagePaths.forEach(imagePath => {
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
  });
}

function cleanupTempPdf(tempPdfPath) {
  if (tempPdfPath && fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
}

// Ana API endpoint'i (önce pdftools, sonra gerekirse GPT)
app.post('/api/analyze-pdf', async (req, res) => {
  let imagePaths = [];
  let tempPdfPath = null;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parametresi gerekli',
      });
    }

    // URL validasyonu
    try {
      new URL(url);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz URL formatı',
      });
    }

    // PDF'i indir
    console.log('PDF indiriliyor...');
    const pdfBuffer = await downloadPDF(url);

    // PDF'i görüntüye çevir (Linux'ta { imagePaths, tempPdfPath }, diğerlerinde sadece imagePaths)
    console.log('PDF görüntüye çevriliyor...');
    const convertResult = await convertPDFToImages(pdfBuffer);
    if (Array.isArray(convertResult)) {
      imagePaths = convertResult;
    } else {
      imagePaths = convertResult.imagePaths || [];
      tempPdfPath = convertResult.tempPdfPath || null;
    }

    if (imagePaths.length === 0) {
      cleanupTempPdf(tempPdfPath);
      return res.status(500).json({
        success: false,
        error: 'PDF görüntüye çevrilemedi',
      });
    }

    let result;

    if (process.platform === 'linux' && tempPdfPath) {
      // Linux: pdftotext + zbarimg ile deterministik analiz (poppler-utils + zbar-tools)
      console.log('pdftotext + zbarimg ile analiz ediliyor...');
      const pdftoolsResult = await analyzePDFWithPdftools(tempPdfPath, imagePaths);
      if (pdftoolsResult && (pdftoolsResult.barcode || pdftoolsResult.referenceNumber)) {
        result = pdftoolsResult;
      }
      cleanupTempPdf(tempPdfPath);
    }

    if (!result) {
      console.log('GPT ile analiz ediliyor...');
      result = await analyzePDFWithGPT(imagePaths);
    }

    // Geçici dosyaları temizle
    cleanupTempFiles(imagePaths);

    // Sonucu döndür
    res.json({
      success: true,
      data: {
        barcode: result.barcode || null,
        referenceNumber: useReference ? (result.referenceNumber || null) : null,
      },
    });
  } catch (error) {
    cleanupTempPdf(tempPdfPath);
    if (imagePaths.length > 0) {
      cleanupTempFiles(imagePaths);
    }

    console.error('Hata:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Bilinmeyen bir hata oluştu',
    });
  }
});

// Sadece GPT ile analiz eden ek endpoint
// Bu endpoint her zaman PDF'i görüntüye çevirip GPT'ye yollar (pdftotext / zbarimg kullanılmaz)
app.post('/api/analyze-pdf-gpt', async (req, res) => {
  let imagePaths = [];

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parametresi gerekli',
      });
    }

    // URL validasyonu
    try {
      new URL(url);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz URL formatı',
      });
    }

    // PDF'i indir
    console.log('[GPT ONLY] PDF indiriliyor...');
    const pdfBuffer = await downloadPDF(url);

    // PDF'i görüntüye çevir
    console.log('[GPT ONLY] PDF görüntüye çevriliyor...');
    const convertResult = await convertPDFToImages(pdfBuffer);
    imagePaths = Array.isArray(convertResult)
      ? convertResult
      : (convertResult.imagePaths || []);

    if (imagePaths.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'PDF görüntüye çevrilemedi',
      });
    }

    // GPT ile analiz et
    console.log('[GPT ONLY] GPT ile analiz ediliyor...');
    const result = await analyzePDFWithGPT(imagePaths);

    // Geçici dosyaları temizle
    cleanupTempFiles(imagePaths);

    // Sonucu döndür
    res.json({
      success: true,
      data: {
        barcode: result.barcode || null,
        referenceNumber: useReference ? (result.referenceNumber || null) : null,
      },
    });
  } catch (error) {
    if (imagePaths.length > 0) {
      cleanupTempFiles(imagePaths);
    }

    console.error('[GPT ONLY] Hata:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Bilinmeyen bir hata oluştu',
    });
  }
});

// YOLO + OpenCV + pdf2image kullanan harici Python servisine delegasyon
// Bu endpoint yalnızca barkod numarası döndürür (referans yok)
app.post('/api/analyze-pdf-barcode-ai', async (req, res) => {
  if (!barcodeServiceUrl) {
    return res.status(500).json({
      success: false,
      error: 'BARCODE_SERVICE_URL tanımlı değil. Lütfen .env içinde Python servis URL\'ini ayarlayın.',
    });
  }

  let tempPdfPath = null;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parametresi gerekli',
      });
    }

    try {
      new URL(url);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz URL formatı',
      });
    }

    console.log('[BARCODE-AI] PDF indiriliyor...');
    const pdfBuffer = await downloadPDF(url);

    // PDF'i geçici dosyaya yaz (sadece log/debug için, Python servisine buffer olarak gidecek)
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const timestamp = Date.now();
    tempPdfPath = path.join(tempDir, `temp_ai_${timestamp}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfBuffer);

    console.log('[BARCODE-AI] Python servisine gönderiliyor...');
    const cleanBaseUrl = barcodeServiceUrl.endsWith('/')
      ? barcodeServiceUrl.slice(0, -1)
      : barcodeServiceUrl;
    const response = await axios.post(
      `${cleanBaseUrl}/analyze-barcode`,
      pdfBuffer,
      {
        headers: {
          'Content-Type': 'application/pdf',
        },
        timeout: 60000,
      }
    );

    if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);

    const data = response.data || {};
    return res.json({
      success: !!data.success,
      data: {
        barcode: data.barcode || null,
        symbology: data.symbology || null,
        confidence: data.confidence ?? null,
      },
      error: data.success ? null : (data.error || null),
    });
  } catch (error) {
    if (tempPdfPath && fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
    console.error('[BARCODE-AI] Hata:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Bilinmeyen bir hata oluştu',
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'API çalışıyor' });
});

// Sunucuyu başlat
app.listen(port, () => {
  console.log(`Server ${port} portunda çalışıyor`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`API endpoint: POST http://localhost:${port}/api/analyze-pdf`);
});
