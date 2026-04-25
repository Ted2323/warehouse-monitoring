"""
STEP 1 — DATA COLLECTION
Downloads the warehouse PPE + asset-status dataset from Roboflow.

The new dataset has 8 classes (see ml/classes.py:CLASS_NAMES):
    worker_with_helmet, worker_no_helmet,
    worker_with_reflective, worker_no_reflective_vest,
    pallet_filled, pallet_empty,
    forklift_with_boxes, forklift_no_carry

The data.yaml shipped with the dataset MUST declare these names in this exact
order — class IDs come from YAML order.
"""

import os
import subprocess
import sys

def install_deps():
    subprocess.check_call([sys.executable, "-m", "pip", "install", "roboflow", "-q"])

def download_dataset(api_key: str, output_dir: str = "./dataset"):
    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)

    # TODO: replace with the new PPE + asset-status dataset coordinates.
    # Expected classes (in this order): worker_with_helmet, worker_no_helmet,
    # worker_with_reflective, worker_no_reflective_vest, pallet_filled,
    # pallet_empty, forklift_with_boxes, forklift_no_carry.
    workspace_slug = os.environ.get("ROBOFLOW_WORKSPACE", "TODO_WORKSPACE_SLUG")
    project_slug   = os.environ.get("ROBOFLOW_PROJECT",   "TODO_PROJECT_SLUG")
    version_num    = int(os.environ.get("ROBOFLOW_VERSION", "1"))

    project = rf.workspace(workspace_slug).project(project_slug)
    dataset = project.version(version_num).download("yolov8", location=output_dir)

    print(f"✅ Dataset downloaded to: {dataset.location}")
    print(f"   Classes: {dataset.classes}")
    print(f"   Train images: {len(os.listdir(os.path.join(output_dir, 'train/images')))}")
    print(f"   Valid images: {len(os.listdir(os.path.join(output_dir, 'valid/images')))}")
    return dataset

def verify_dataset(output_dir: str = "./dataset"):
    """Check that YAML and images exist."""
    yaml_path = os.path.join(output_dir, "data.yaml")
    if not os.path.exists(yaml_path):
        raise FileNotFoundError(f"data.yaml not found at {yaml_path}")

    import yaml
    with open(yaml_path) as f:
        config = yaml.safe_load(f)

    print("\n📋 Dataset config:")
    print(f"   nc (num classes): {config.get('nc')}")
    print(f"   names: {config.get('names')}")
    return yaml_path

if __name__ == "__main__":
    # Set your Roboflow API key here or via environment variable
    API_KEY = os.environ.get("ROBOFLOW_API_KEY", "YOUR_ROBOFLOW_API_KEY")

    install_deps()
    download_dataset(api_key=API_KEY)
    verify_dataset()
