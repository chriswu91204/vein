#!/bin/bash
# 讀取 VEIN 最新 feed → 存成 $1（預設 feed.json）。在任何有 gh 的環境都能跑。
OUT=${1:-feed.json}; R=chriswu91204/vein
before=$(gh api "repos/$R/actions/workflows/diag.yml/runs?per_page=1" -q '.workflow_runs[0].id')
gh api -X POST repos/$R/actions/workflows/diag.yml/dispatches -f ref=main -f 'inputs[script]=feedraw.js' || exit 1
for i in $(seq 1 60); do id=$(gh api "repos/$R/actions/workflows/diag.yml/runs?per_page=1" -q '.workflow_runs[0].id'); st=$(gh api "repos/$R/actions/runs/$id" -q .status); [ "$id" != "$before" ] && [ "$st" = completed ] && break; sleep 5; done
gh run view $id -R $R --log | cut -f3- | sed -E 's/^[0-9T:.-]+Z //' | awk '/^===FEED64===/{f=1;next}/^===END===/{f=0}f' | tr -d '\r\n ' | base64 -d > "$OUT"
python3 -c "import json,sys;F=json.load(open('$OUT'));print('feed ok',F['count'],'items')"
