#!/usr/bin/env python3
"""
Download CRAG dataset (Task 3) raw data.

Downloads from GitHub (facebookresearch/CRAG), merges split archives,
and extracts to datasets/crag-raw.

Use build_crag.py to process the raw data into the format needed for benchmarks.
"""

import argparse
import subprocess
import urllib.request
from pathlib import Path

from tqdm import tqdm

CRAG_TASK_3_BASE_URL = (
    "https://github.com/facebookresearch/CRAG/raw/main/data/crag_task_3_dev_v4.tar.bz2"
)
CRAG_TASK_3_PARTS = 4


def download_file(url: str, dest: Path) -> None:
    """Download a file with progress bar."""
    print(f"Downloading {url}...")

    with urllib.request.urlopen(url) as response:
        total_size = int(response.headers.get("Content-Length", 0))

        with open(dest, "wb") as f:
            with tqdm(total=total_size, unit="B", unit_scale=True) as pbar:
                while True:
                    chunk = response.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
                    pbar.update(len(chunk))


def download_task3_parts(output_dir: Path) -> Path:
    """Download and merge Task 3 archive parts."""
    merged_file = output_dir / "crag_task_3_dev_v4.tar.bz2"

    if merged_file.exists():
        print(f"Using cached archive: {merged_file}")
        return merged_file

    # Download all parts
    part_files: list[Path] = []
    for i in range(1, CRAG_TASK_3_PARTS + 1):
        part_url = f"{CRAG_TASK_3_BASE_URL}.part{i}"
        part_file = output_dir / f"crag_task_3_dev_v4.tar.bz2.part{i}"

        if not part_file.exists():
            download_file(part_url, part_file)
        else:
            print(f"Using cached part: {part_file}")

        part_files.append(part_file)

    # Merge parts
    print("Merging archive parts...")
    with open(merged_file, "wb") as outf:
        for part_file in part_files:
            with open(part_file, "rb") as inf:
                while True:
                    chunk = inf.read(8192)
                    if not chunk:
                        break
                    outf.write(chunk)

    print(f"Merged archive: {merged_file}")
    return merged_file


def extract_archive(archive_path: Path, output_dir: Path) -> Path:
    """Extract tar.bz2 using system tar."""
    extract_dir = output_dir / "extracted"

    # Check if already extracted
    if extract_dir.exists():
        jsonl_files = list(extract_dir.rglob("*.jsonl"))
        if jsonl_files:
            print(f"Using cached extraction: {extract_dir}")
            return extract_dir

    # Extract using system tar (much faster than Python tarfile)
    print(f"Extracting {archive_path} using system tar...")
    extract_dir.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ["tar", "xjf", str(archive_path), "-C", str(extract_dir)],
        check=True,
    )

    jsonl_files = list(extract_dir.rglob("*.jsonl"))
    print(f"Found {len(jsonl_files)} JSONL files")

    return extract_dir


def download_crag(output_dir: Path) -> None:
    """
    Download CRAG Task 3 dataset.

    Args:
        output_dir: Directory to save raw data
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Download and merge archive parts
    archive_path = download_task3_parts(output_dir)

    # Extract archive
    extract_dir = extract_archive(archive_path, output_dir)

    print("\nDownload complete!")
    print(f"Raw data saved to: {output_dir}")
    print(f"Extracted files in: {extract_dir}")
    print("\nRun build_crag.py to process the data for benchmarks.")


def main():
    parser = argparse.ArgumentParser(
        description="Download CRAG Task 3 dataset raw data"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="datasets/crag-raw",
        help="Output directory for raw data (default: datasets/crag-raw)",
    )

    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        script_dir = Path(__file__).parent.parent
        output_dir = script_dir / output_dir

    download_crag(output_dir=output_dir)


if __name__ == "__main__":
    main()
