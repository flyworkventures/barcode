# PDF Barkod ve Referans Numarası Analiz API'si

Bu API, URL olarak gönderilen PDF dosyalarından barkod ve referans numarasını çıkarır. **Linux** sunucularda önce **pdftotext** (referans) ve **zbarimg** (barkod) ile deterministik analiz yapılır; sonuç alınamazsa GPT-4o Vision fallback olarak kullanılır. Windows/macOS'ta yalnızca GPT kullanılır.

## Kurulum

1. Bağımlılıkları yükleyin:
```bash
npm install
```

2. `.env` dosyası oluşturun ve OpenAI API anahtarınızı ekleyin:
```bash
cp .env.example .env
```

`.env` dosyasını düzenleyin:
```
OPENAI_API_KEY=your_openai_api_key_here
PORT=3000
```

### Linux sunucuda tam doğruluk (pdftotext + zbarimg)

Linux'ta **%100 doğru** sonuç için sistemde şu paketler kurulu olmalı:

- **poppler-utils** – PDF'ten metin (pdftotext) ve sayfa görüntüsü (pdftoppm) için
- **zbar-tools** – Barkod okuma (zbarimg) için

Kurulum örnekleri:

- **Debian / Ubuntu:**  
  `sudo apt-get update && sudo apt-get install -y poppler-utils zbar-tools`
- **CentOS / RHEL / Fedora:**  
  `sudo yum install -y poppler-utils zbar` veya `sudo dnf install -y poppler-utils zbar`
- **Alpine:**  
  `apk add poppler-utils zbar-tools`

Bu araçlar yoksa veya hata alınırsa API otomatik olarak GPT ile analiz eder.

## Kullanım

### Sunucuyu Başlatma

```bash
npm start
```

veya geliştirme modu için:

```bash
npm run dev
```

### API Kullanımı

**Endpoint:** `POST /api/analyze-pdf`

**Request Body:**
```json
{
  "url": "https://example.com/document.pdf"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "barcode": "1234567890123",
    "referenceNumber": "REF-2024-001"
  }
}
```

**Hata Response:**
```json
{
  "success": false,
  "error": "Hata mesajı"
}
```

### Örnek cURL İsteği

```bash
curl -X POST http://localhost:3000/api/analyze-pdf \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/document.pdf"}'
```

### Health Check

```bash
curl http://localhost:3000/health
```

## Notlar

- **Linux:** Önce pdftotext (referans) ve zbarimg (barkod) kullanılır; sonuç alınamazsa GPT-4o Vision devreye girer.
- **Windows/macOS:** Yalnızca GPT-4o Vision ile analiz yapılır (pdftotext/zbarimg sistemde opsiyonel).
- Geçici dosyalar otomatik olarak temizlenir.
- **Referansı kapatmak için:** `.env` içinde `USE_REFERENCE=0` yazın; yanıt her zaman `referenceNumber: null` döner.
- **Sadece EAN-13 barkod:** `.env` içinde `BARCODE_EAN13_ONLY=1` yazın; zbarimg yalnızca EAN-13 tarar ve sadece 13 haneli barkod kabul edilir.
