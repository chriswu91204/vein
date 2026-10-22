// 網站擁有者（超級管理員）的 Google 帳號。用這些帳號登入就自動是最高權限管理員，不需要在資料庫另外設定。
// 修改這裡時，也要同步修改 firestore.rules 裡的 isOwner()。
export const OWNER_EMAILS = ['chriswu91204@gmail.com'];

// 擋機器人（Firebase App Check · reCAPTCHA v3）：在 Firebase 主控台 → App Check 註冊網頁應用程式後，把「網站金鑰」（公開的）貼在這裡。
// 留空＝不啟用。啟用並確認網站正常後，再到 App Check 對 Firestore、Storage 按「強制執行」。
export const APPCHECK_SITE_KEY = '';
