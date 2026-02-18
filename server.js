const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const gptModel = process.env.GPT_MODEL || 'gpt-4o'; // GPT-5.2 mevcut olduğunda buraya yazılabilir

// OpenAI client'ı başlat
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

// PDF'i görüntüye çevir (pdf-poppler kullanarak - Linux uyumlu)
async function convertPDFToImages(pdfBuffer) {
  const pdfPoppler = require('pdf-poppler');
  const tempDir = path.join(__dirname, 'temp');
  
  // Temp dizini yoksa oluştur
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempPdfPath = path.join(tempDir, `temp_${Date.now()}.pdf`);
  fs.writeFileSync(tempPdfPath, pdfBuffer);

  const options = {
    format: 'png',
    out_dir: tempDir,
    out_prefix: `page_${Date.now()}`,
    page: null, // Tüm sayfalar
  };

  try {
    await pdfPoppler.convert(tempPdfPath, options);
    
    // Oluşturulan görüntü dosyalarını bul
    const files = fs.readdirSync(tempDir);
    const imageFiles = files
      .filter(file => file.startsWith(options.out_prefix) && file.endsWith('.png'))
      .map(file => path.join(tempDir, file))
      .sort();

    // Geçici PDF dosyasını sil
    fs.unlinkSync(tempPdfPath);

    return imageFiles;
  } catch (error) {
    // Geçici PDF dosyasını sil
    if (fs.existsSync(tempPdfPath)) {
      fs.unlinkSync(tempPdfPath);
    }
    throw new Error(`PDF görüntüye çevirme hatası: ${error.message}`);
  }
}

// Görüntüyü base64'e çevir
function imageToBase64(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

// GPT ile PDF'i analiz et
async function analyzePDFWithGPT(imagePaths) {
  try {
    // Tüm görüntüleri base64 formatına çevir
    const imageContents = await Promise.all(
      imagePaths.map(imagePath => {
        const base64Image = imageToBase64(imagePath);
        return {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64Image}`,
          },
        };
      })
    );

    // GPT Vision API ile analiz (PDF resimlere çevrildikten sonra)
    const response = await openai.chat.completions.create({
      model: gptModel,
      messages: [
        {
          role: 'system',
          content: `Sen bir PDF analiz uzmanısın. PDF'lerdeki barkod ve referans numaralarını bulmakla görevlisin. 
          PDF'in içeriğini analiz et ve aşağıdaki bilgileri JSON formatında döndür:
          - barcode: Barkod numarası (varsa)
          - referenceNumber: Referans numarası (varsa)
          
          Eğer bulamazsan, ilgili alanı null olarak döndür. Sadece JSON formatında cevap ver, başka açıklama yapma.`,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Bu PDF\'deki barkod ve referans numarasını bul ve JSON formatında döndür.',
            },
            ...imageContents,
          ],
        },
      ],
      max_completion_tokens: 16384, // Maksimum token limiti
    });

    const content = response.choices[0].message.content;
    
    // JSON'u parse et
    try {
      // Eğer içerik JSON bloğu içeriyorsa (```json ... ```) çıkar
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonString = jsonMatch ? jsonMatch[1] : content;
      return JSON.parse(jsonString.trim());
    } catch (parseError) {
      // JSON parse edilemezse, içeriği manuel olarak parse etmeye çalış
      const barcodeMatch = content.match(/barcode["\s:]+([^",}\s]+)/i);
      const refMatch = content.match(/referenceNumber["\s:]+([^",}\s]+)/i) || 
                       content.match(/referans["\s:]+([^",}\s]+)/i);
      
      return {
        barcode: barcodeMatch ? barcodeMatch[1] : null,
        referenceNumber: refMatch ? refMatch[1] : null,
      };
    }
  } catch (error) {
    throw new Error(`GPT analiz hatası: ${error.message}`);
  }
}

// Geçici dosyaları temizle
function cleanupTempFiles(imagePaths) {
  imagePaths.forEach(imagePath => {
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
  });
}

// Ana API endpoint'i
app.post('/api/analyze-pdf', async (req, res) => {
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
    console.log('PDF indiriliyor...');
    const pdfBuffer = await downloadPDF(url);

    // PDF'i görüntüye çevir
    console.log('PDF görüntüye çevriliyor...');
    imagePaths = await convertPDFToImages(pdfBuffer);

    if (imagePaths.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'PDF görüntüye çevrilemedi',
      });
    }

    // GPT ile analiz et
    console.log('GPT ile analiz ediliyor...');
    const result = await analyzePDFWithGPT(imagePaths);

    // Geçici dosyaları temizle
    cleanupTempFiles(imagePaths);

    // Sonucu döndür
    res.json({
      success: true,
      data: {
        barcode: result.barcode || null,
        referenceNumber: result.referenceNumber || null,
      },
    });
  } catch (error) {
    // Hata durumunda geçici dosyaları temizle
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
