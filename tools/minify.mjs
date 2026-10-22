// 部署前把 public/index.html 裡的 CSS 與 JS 壓縮（只在 GitHub Actions 部署時跑，原始碼不變）
// 用法：node tools/minify.mjs <esbuild 執行檔路徑> [檔案]
// 安全做法：每一段壓縮後先檢查語法，有任何問題就保留原本那段
import fs from 'fs';
import { spawnSync } from 'child_process';
import vm from 'vm';
const bin = process.argv[2] || 'node_modules/.bin/esbuild';
const file = process.argv[3] || 'public/index.html';
const src = fs.readFileSync(file, 'utf8');
const run = (code, loader) => {
  const r = spawnSync(bin, ['--loader=' + loader, '--minify', '--charset=utf8', '--legal-comments=none', ...(loader === 'js' ? ['--target=es2020'] : [])], { input: code, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'esbuild failed');
  return r.stdout.trim();
};
let kept = 0, done = 0;
let out = src.replace(/<script>([\s\S]*?)<\/script>/g, (m, code) => {
  try {
    const min = run(code, 'js').replace(/<\/script/gi, '<\\/script');
    new vm.Script(min); // 只檢查語法，不執行
    done++; return '<script>' + min + '</script>';
  } catch (e) { kept++; console.warn('[minify] 保留原始 script：', String(e.message).slice(0, 200)); return m; }
});
out = out.replace(/<style>([\s\S]*?)<\/style>/g, (m, css) => {
  try { const min = run(css, 'css'); if (!min) throw new Error('empty'); done++; return '<style>' + min + '</style>'; }
  catch (e) { kept++; console.warn('[minify] 保留原始 style：', String(e.message).slice(0, 200)); return m; }
});
fs.writeFileSync(file, out);
console.log(`[minify] ${file}: ${src.length} → ${out.length} bytes（壓縮 ${done} 段、保留 ${kept} 段）`);
