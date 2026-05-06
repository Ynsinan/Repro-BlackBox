#!/usr/bin/env bash
# Repro Blackbox — kütüphane indirici
#
# Sadece JSZip gerekli (ZIP üretimi için). Video kaydı native
# chrome.tabCapture + MediaRecorder ile yapılır, ek kütüphane yok.
#
# Kullanım:
#   bash lib/download-libs.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "→ JSZip v3.10.1 indiriliyor…"
curl -fsSL "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" -o jszip.min.js

echo "✓ Tamam."
ls -1 *.js 2>/dev/null
