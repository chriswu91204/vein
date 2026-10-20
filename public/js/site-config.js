// 網站擁有者（超級管理員）的 Google 帳號。用這些帳號登入就自動是最高權限管理員，不需要在資料庫另外設定。
// 修改這裡時，也要同步修改 firestore.rules 裡的 isOwner()。
export const OWNER_EMAILS = ['chriswu91204@gmail.com'];
