#!/usr/bin/env bash
# Chạy trong thư mục chứa 16 file .tex
set -euo pipefail
mkdir -p pdf
for file in [0-9][0-9]_*.tex; do
  name="${file%.tex}"
  echo "--- Biên dịch $file ---"
  xelatex -interaction=nonstopmode -halt-on-error -output-directory=pdf "$file" >/dev/null
  xelatex -interaction=nonstopmode -halt-on-error -output-directory=pdf "$file" >/dev/null
done
echo "Hoàn tất: 16 file PDF tại thư mục pdf/"
