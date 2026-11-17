#!/usr/bin/env bash
# PC(맥/리눅스)에서 실행: Hugging Face git 저장소에서 Gemma 3 4B QAT Q4_0 GGUF 를 받아
# 기기로 옮길 조각 파일을 만든다. (앱 자체는 네트워크를 쓰지 않는다)
#
# 사전 준비
#   1) https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf 에서 Gemma 라이선스 동의
#   2) git, git-lfs, python3 설치,  git lfs install
#   3) HF 토큰(read) 준비 → git 이 비밀번호를 물으면 토큰을 입력
#
# 사용법
#   bash tools/pack_model.sh            # 1900M 조각 (GitHub Release / LFS 용)
#   PART_SIZE=95M bash tools/pack_model.sh   # LFS 없는 일반 git 커밋용
set -euo pipefail

REPO_URL="${REPO_URL:-https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf}"
MODEL_FILE="${MODEL_FILE:-gemma-3-4b-it-q4_0.gguf}"
PART_SIZE="${PART_SIZE:-1900M}"
WORK="${WORK:-model-src}"
OUT="${OUT:-model-dist}"
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v git-lfs >/dev/null || { echo "git-lfs 가 필요합니다: https://git-lfs.com"; exit 1; }

if [ ! -d "$WORK/.git" ]; then
  echo "▶ git clone (LFS 본문은 아직 받지 않음): $REPO_URL"
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 "$REPO_URL" "$WORK"
fi

echo "▶ git lfs pull: $MODEL_FILE  (약 3.2GB)"
git -C "$WORK" lfs pull --include "$MODEL_FILE"

echo "▶ $PART_SIZE 단위로 분할 + SHA256SUMS 생성 → $OUT/"
python3 "$HERE/split_model.py" "$WORK/$MODEL_FILE" --size "$PART_SIZE" --out "$OUT"

cat <<MSG

완료. 다음 중 하나로 배포/전송하세요.

  (A) GitHub Release 로 올리기 (권장, 조각당 2GiB 이하)
      gh release create model-v1 $OUT/* --repo <you>/<repo> --title "Gemma 3 4B QAT Q4_0"
      # 받는 쪽: gh release download model-v1 --repo <you>/<repo> -D $OUT

  (B) 바로 기기로 복사
      Android: USB 연결 후 $OUT/ 안의 파일 전부를 Download 폴더로 복사
               (또는 adb push $OUT/. /sdcard/Download/gemma/)
      iPhone : Finder > iPhone > 파일 > Gemma Chat 으로 드래그 (또는 AirDrop → 파일 앱)

앱에서 "모델 파일 선택"으로 조각 전부 + SHA256SUMS 를 함께 고르면
기기 안에서 이어 붙이고 검증해서 설치합니다.
MSG
