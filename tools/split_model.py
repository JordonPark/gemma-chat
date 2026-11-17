#!/usr/bin/env python3
"""
GGUF 모델을 git(GitHub Release / Git LFS)에 올릴 수 있는 크기로 나누고 SHA256SUMS 를 만든다.

  python3 tools/split_model.py gemma-3-4b-it-q4_0.gguf --size 1900M --out model-dist

결과:
  model-dist/gemma-3-4b-it-q4_0.gguf.part00
  model-dist/gemma-3-4b-it-q4_0.gguf.part01
  model-dist/SHA256SUMS      (원본 전체 + 각 조각의 해시)
  model-dist/manifest.json   (앱의 자동 다운로드가 읽는 목록: 조각 이름/크기/해시)

조각 크기 기준:
  - GitHub Release 첨부파일 한도 2 GiB  → 1900M (기본값)
  - Git LFS (무료 계정) 파일 한도 2 GB  → 1900M
  - LFS 없이 일반 git 커밋               → 95M  (GitHub 100MB 한도)
"""
import argparse
import hashlib
import json
import os
import sys

BUF = 8 * 1024 * 1024


def parse_size(s: str) -> int:
    s = s.strip().upper()
    mult = {"K": 1024, "M": 1024**2, "G": 1024**3}
    if s[-1] in mult:
        return int(float(s[:-1]) * mult[s[-1]])
    return int(s)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--size", default="1900M", help="조각 크기 (예: 1900M, 95M)")
    ap.add_argument("--out", default="model-dist")
    a = ap.parse_args()

    size = parse_size(a.size)
    name = os.path.basename(a.model)
    os.makedirs(a.out, exist_ok=True)

    with open(a.model, "rb") as f:
        if f.read(4) != b"GGUF":
            print(f"오류: {a.model} 는 GGUF 파일이 아닙니다 (git lfs pull 을 했는지 확인).", file=sys.stderr)
            return 1

    total = os.path.getsize(a.model)
    whole = hashlib.sha256()
    lines = []
    parts = []
    idx = 0
    with open(a.model, "rb") as f:
        while True:
            part_name = f"{name}.part{idx:02d}"
            h = hashlib.sha256()
            written = 0
            with open(os.path.join(a.out, part_name), "wb") as out:
                while written < size:
                    chunk = f.read(min(BUF, size - written))
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    whole.update(chunk)
                    written += len(chunk)
            if written == 0:
                os.remove(os.path.join(a.out, part_name))
                break
            lines.append(f"{h.hexdigest()}  {part_name}")
            parts.append({"name": part_name, "size": written, "sha256": h.hexdigest()})
            print(f"  {part_name}  {written / 1024**2:,.0f} MiB")
            idx += 1
            if written < size:
                break

    lines.insert(0, f"{whole.hexdigest()}  {name}")
    with open(os.path.join(a.out, "SHA256SUMS"), "w") as s:
        s.write("\n".join(lines) + "\n")
    manifest = {
        "format": 1,
        "name": name,
        "size": total,
        "sha256": whole.hexdigest(),
        "license": "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms",
        "parts": parts,
    }
    with open(os.path.join(a.out, "manifest.json"), "w") as m:
        json.dump(manifest, m, indent=2)
    print(f"완료: {idx}개 조각, 전체 {total / 1024**3:.2f} GiB, SHA256 {whole.hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
