# PDF Barkod ve Referans Numarası Analiz API'si

Bu API, URL olarak gönderilen PDF dosyalarını GPT-4o ile analiz ederek barkod ve referans numarasını çıkarır.

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

- API, PDF'i görüntüye çevirerek GPT-4o Vision API ile analiz eder
- Geçici dosyalar otomatik olarak temizlenir
- GPT-5.2 henüz mevcut olmadığı için GPT-4o kullanılmaktadır
