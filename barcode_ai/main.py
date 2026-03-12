from fastapi import FastAPI, HTTPException, Body
from fastapi.responses import JSONResponse
from pdf2image import convert_from_bytes
from typing import List, Optional
from io import BytesIO
import cv2
import numpy as np
import subprocess
import tempfile
import os

try:
    from ultralytics import YOLO
    _yolo_available = True
except Exception:
    YOLO = None
    _yolo_available = False

app = FastAPI(title="Barcode AI Service")

_yolo_model: Optional["YOLO"] = None


def get_yolo_model() -> Optional["YOLO"]:
    global _yolo_model
    if not _yolo_available:
        return None
    if _yolo_model is None:
        # Varsayılan olarak barkod için eğitilmiş bir YOLOv8 checkpoint bekliyoruz.
        # Bu dosyayı proje dışından sağlayacaksın (örn. yol: ./models/yolov8n-barcode.pt)
        _yolo_model = YOLO("models/YOLOV8s_Barcode_Detection.pt")
    return _yolo_model


def preprocess_page(pil_img):
    """YOLO ve decoder'lar için sayfa görselini hazırlar."""
    img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    th = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31, 10
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    proc = cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel, iterations=1)
    return img, proc


def decode_with_zbarimg(roi_bgr) -> List[dict]:
    """ROI'yi geçici PNG'ye kaydedip zbarimg CLI ile decode et."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        cv2.imwrite(tmp_path, roi_bgr)

        try:
            out = subprocess.check_output(
                ["zbarimg", "-q", tmp_path],
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except subprocess.CalledProcessError:
            out = ""

    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)

    results: List[dict] = []
    for line in (out or "").strip().splitlines():
        parts = line.split(":", 1)
        if len(parts) != 2:
            continue
        sym, val = parts[0].strip(), parts[1].strip()
        results.append({
            "value": val,
            "symbology": sym,
            "source": "zbarimg",
        })
    return results


def validate_barcode(value: str, symbology: str) -> bool:
    """Sadece gerçek ürün barkodlarını (EAN-13 / CODE128) kabul et."""
    sym = symbology.upper()

    # QR kodları tamamen dışla
    if "QR" in sym:
        return False

    if sym in ("EAN13", "EAN-13"):
        if len(value) != 13 or not value.isdigit():
            return False
        # EAN-13 checksum
        digits = [int(c) for c in value]
        s = sum(digits[0:12:2]) + sum(d * 3 for d in digits[1:12:2])
        check = (10 - (s % 10)) % 10
        return check == digits[12]
    # CODE128 için: en az 8 hane ve tamamen sayısal olsun
    if sym in ("CODE128", "CODE-128"):
        return len(value) >= 8 and value.isdigit()
    return True


def merge_results(candidates: List[dict]) -> Optional[dict]:
    """Aynı barkod değerine oy verip en güvenilir sonucu seç."""
    if not candidates:
        return None

    # Aynı value+symbology kombinasyonlarına göre say
    votes = {}
    for c in candidates:
        key = (c["value"], c.get("symbology", ""))
        votes.setdefault(key, []).append(c)

    # En çok görüleni seç
    best_key, best_list = max(votes.items(), key=lambda kv: len(kv[1]))
    value, sym = best_key

    # Basit confidence: min(1.0, 0.4 + 0.2 * adet)
    count = len(best_list)
    confidence = min(1.0, 0.4 + 0.2 * (count - 1))

    return {
        "value": value,
        "symbology": sym,
        "confidence": confidence,
    }


@app.post("/analyze-barcode")
async def analyze_barcode(pdf: bytes = Body(..., media_type="application/pdf")):
    """
    PDF artwork içinden barkod tespiti:
    1) PDF → sayfa görüntüleri (pdf2image)
    2) OpenCV ile ön işleme
    3) YOLOv8 ile barkod bbox'ları (varsa)
    4) Crop + zbarimg (CLI) ile decode
    """
    try:
        # Büyük PDF'lerde süreyi sınırlamak için ilk birkaç sayfayla başla
        pages = convert_from_bytes(pdf, dpi=400, first_page=1, last_page=4)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF sayfalara çevrilemedi: {e}")

    yolo_model = get_yolo_model()
    all_candidates: List[dict] = []

    for pil_page in pages:
        img_bgr, _ = preprocess_page(pil_page)

        # YOLO varsa: barkod bbox'larını bul, yoksa tüm sayfadan dene
        rois: List[np.ndarray] = []

        if yolo_model is not None:
            try:
                results = yolo_model(img_bgr)
                for r in results:
                    boxes = r.boxes
                    if boxes is None:
                        continue
                    for box in boxes:
                        conf = float(box.conf[0])
                        if conf < 0.3:
                            continue
                        x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                        x1 = max(0, x1)
                        y1 = max(0, y1)
                        x2 = min(img_bgr.shape[1], x2)
                        y2 = min(img_bgr.shape[0], y2)
                        if x2 <= x1 or y2 <= y1:
                            continue
                        roi = img_bgr[y1:y2, x1:x2]
                        if roi.size == 0:
                            continue
                        # Farklı rotasyonlarla deneyelim
                        rois.extend([
                            roi,
                            cv2.rotate(roi, cv2.ROTATE_90_CLOCKWISE),
                            cv2.rotate(roi, cv2.ROTATE_90_COUNTERCLOCKWISE),
                            cv2.rotate(roi, cv2.ROTATE_180),
                        ])
            except Exception:
                # YOLO hata verirse sayfanın tamamını deneyeceğiz
                pass

        if not rois:
            rois = [img_bgr]

        for roi in rois:
            decoded = decode_with_zbarimg(roi)
            for d in decoded:
                if not validate_barcode(d["value"], d["symbology"]):
                    continue
                all_candidates.append(d)

        # Birden çok sayfadan da olsa ilk makul sonucu bulduysak erken çıkabiliriz
        best = merge_results(all_candidates)
        if best is not None and best["confidence"] >= 0.8:
            return JSONResponse({
                "success": True,
                "barcode": best["value"],
                "symbology": best["symbology"],
                "confidence": best["confidence"],
            })

    best = merge_results(all_candidates)
    if best is None:
        return JSONResponse({
            "success": False,
            "barcode": None,
            "symbology": None,
            "confidence": 0.0,
            "error": "Barkod tespit edilemedi",
        })

    return JSONResponse({
        "success": True,
        "barcode": best["value"],
        "symbology": best["symbology"],
        "confidence": best["confidence"],
    })

