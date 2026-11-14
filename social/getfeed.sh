#!/bin/bash
# 讀取 VEIN 最新 feed → 存成 $1（預設 feed.json）。只用 GitHub REST（gh api / gh run），不需要 GraphQL。
# 查詢條件用環境變數 FEED_Q，例如：FEED_Q='days=90&all=1&events=0&limit=100' bash social/getfeed.sh /tmp/feed.json
OUT=${1:-feed.json}; R=chriswu91204/vein; Q=${FEED_Q:-days=14&limit=60}; Q="$Q&_=$(date +%s)"  # 加時間戳避開 5 分鐘快取
before=$(gh api "repos/$R/actions/workflows/diag.yml/runs?per_page=1" -q '.workflow_runs[0].id')
gh api -X POST repos/$R/actions/workflows/diag.yml/dispatches -f ref=main -f 'inputs[script]=feedraw.js' -f "inputs[img_paths]=$Q" || exit 1
for i in $(seq 1 90); do id=$(gh api "repos/$R/actions/workflows/diag.yml/runs?per_page=1" -q '.workflow_runs[0].id'); st=$(gh api "repos/$R/actions/runs/$id" -q .status); [ "$id" != "$before" ] && [ "$st" = completed ] && break; sleep 5; done
T=$(mktemp -d); aid=$(gh api "repos/$R/actions/runs/$id/artifacts" -q '.artifacts[]|select(.name=="diag-out")|.id' | head -1)
[ -n "$aid" ] || { echo "沒有拿到 feed（run $id）"; exit 1; }
gh api "repos/$R/actions/artifacts/$aid/zip" > "$T/a.zip" && (cd "$T" && python3 -c "import zipfile;zipfile.ZipFile('a.zip').extractall('.')") && cp "$T/feed.json" "$OUT"
python3 -c "import json;F=json.load(open('$OUT'));print('feed ok',len(F['items']),'items','（查詢 $Q）')"
