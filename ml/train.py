"""
STEP 2 & 3 — BUILD + TRAIN THE MODEL
Sets up YOLOv8 environment and fine-tunes on warehouse dataset.
Run this in Google Colab, Kaggle, or locally with a GPU.
"""

import os
import subprocess
import sys
import shutil

# ─── CONFIG ────────────────────────────────────────────────────────────────────
# NOTE: the new dataset's data.yaml must declare `nc: 8` and its `names:` list
# must match `ml/classes.py:CLASS_NAMES` exactly, in the same order — Ultralytics
# derives class IDs from YAML order, so a mismatch silently corrupts inference.
CONFIG = {
    "model":        "yolov8n.pt",    # nano = fastest; use yolov8s.pt for better accuracy
    "data_yaml":    "../data/dataset/data.yaml",
    "epochs":       50,
    "imgsz":        640,
    "batch":        16,
    "project":      "./runs",
    "name":         "warehouse_monitor_v2",  # bumped for new 8-class set; keeps old runs intact
    "device":       "cpu",           # GPU index (e.g. "0") if CUDA is available; "cpu" otherwise
    "patience":     10,              # early stopping
    "save_period":  10,
}
# ───────────────────────────────────────────────────────────────────────────────


def install_deps():
    print("📦 Installing dependencies...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "ultralytics", "torch", "torchvision", "-q"])
    print("✅ Dependencies installed.\n")


def train():
    from ultralytics import YOLO

    print("🚀 Starting YOLOv8 training...")
    print(f"   Model:   {CONFIG['model']}")
    print(f"   Epochs:  {CONFIG['epochs']}")
    print(f"   Image:   {CONFIG['imgsz']}px\n")

    model = YOLO(CONFIG["model"])

    results = model.train(
        data=CONFIG["data_yaml"],
        epochs=CONFIG["epochs"],
        imgsz=CONFIG["imgsz"],
        batch=CONFIG["batch"],
        project=CONFIG["project"],
        name=CONFIG["name"],
        device=CONFIG["device"],
        patience=CONFIG["patience"],
        save_period=CONFIG["save_period"],
        verbose=True,
    )

    return results


def export_best_model():
    best_pt = f"{CONFIG['project']}/{CONFIG['name']}/weights/best.pt"

    if not os.path.exists(best_pt):
        raise FileNotFoundError(f"best.pt not found at {best_pt}. Did training complete?")

    # Copy to root for easy access
    dest = "./best.pt"
    shutil.copy(best_pt, dest)
    size_mb = os.path.getsize(dest) / (1024 * 1024)

    print(f"\n✅ Model exported!")
    print(f"   Path: {os.path.abspath(dest)}")
    print(f"   Size: {size_mb:.1f} MB")
    print(f"\n👉 Next step: Upload best.pt to Supabase Storage")
    print(f"   supabase storage cp ./best.pt ss:///models/best.pt")

    return dest


def validate():
    from ultralytics import YOLO

    print("\n📊 Running validation on best model...")
    model = YOLO("./best.pt")
    metrics = model.val(data=CONFIG["data_yaml"])

    print(f"\n📈 Validation Metrics:")
    print(f"   mAP50:    {metrics.box.map50:.4f}")
    print(f"   mAP50-95: {metrics.box.map:.4f}")
    print(f"   Precision:{metrics.box.mp:.4f}")
    print(f"   Recall:   {metrics.box.mr:.4f}")

    return metrics


if __name__ == "__main__":
    install_deps()
    train()
    export_best_model()
    validate()
