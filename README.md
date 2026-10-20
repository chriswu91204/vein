# VEIN · 花燭側芽市集

花燭（Anthurium）側芽的多賣家市集。每株植物都有編號、成長照片和原始拍攝時間，可以一路追溯到母株。網站有競標、直購、抽獎、賣家賣場和後台。

技術：純 HTML/CSS/JS，不需要打包。資料、登入、照片用 Firebase（Firestore、Authentication、Storage），網站放在 Firebase Hosting。

```
public/
  index.html             整個網站（前台、賣家後台、管理後台）
  js/vein-firebase.js    把 Firebase 接到網站的資料介面
  js/firebase-config.js  ← 你的 Firebase 設定（步驟 3-1）
  m/                     影片與照片
firestore.rules          資料庫權限（誰能讀寫什麼）
storage.rules            照片上傳權限
firebase.json            網站託管設定
.firebaserc              ← 你的專案 ID（步驟 3-1）
.github/workflows/       推到 GitHub 就自動部署
```

---

## 步驟 3：第一次上線

### 3-1 填入你的 Firebase 設定
1. 打開 `public/js/firebase-config.js`，把 Firebase 主控台給你的 `firebaseConfig` 貼進去。
2. 打開 `.firebaserc`，把 `YOUR_PROJECT` 改成你的專案 ID，例如 `vein-1a2b3`。

### 3-2 建一把「部署用的鑰匙」，放到 GitHub
GitHub 要有權限把網站部署到你的 Firebase，所以要給它一把鑰匙（服務帳戶）。
1. 打開 console.cloud.google.com，上方選你的 Firebase 專案。
2. 左側選單 → 「IAM 與管理」→「服務帳戶」→「建立服務帳戶」，名稱填 `github-deploy`。
3. 授予角色，加這三個：
   - **Firebase 管理員**（Firebase Admin）
   - **API 金鑰檢視者**（API Keys Viewer）
   - **服務使用情形消費者**（Service Usage Consumer）
4. 建好後點進這個服務帳戶 →「金鑰」→「新增金鑰」→ JSON，會下載一個 `.json` 檔。
5. 到 GitHub repo →「Settings」→「Secrets and variables」→「Actions」→「New repository secret」。
   - Name：`FIREBASE_SERVICE_ACCOUNT`
   - Secret：把剛剛 `.json` 檔的**全部內容**貼上
6. ⚠️ 這個 `.json` 檔就是鑰匙：不要傳給任何人，也不要放進 repo。貼到 GitHub 之後就可以刪掉。

### 3-3 推上 GitHub
把整個資料夾推到 repo 的 `main` 分支。GitHub 的「Actions」分頁會開始部署，大約 2 分鐘。
完成後網站在 `https://你的專案ID.web.app`。

### 3-4 把自己設成管理員
1. 打開網站，用 Google 登入一次。
2. Firebase 主控台 → Authentication →「使用者」，複製你那一列的「使用者 UID」。
3. Firebase 主控台 → Firestore →「開始集合」：
   - 集合 ID：`site`
   - 文件 ID：`admins`
   - 欄位：`uids`，類型選 **map**，在裡面加一個欄位：名稱是你的 UID，類型 boolean，值 `true`
4. 重新整理網站 → 右上角頭像 →「管理後台」。第一次打開會自動建立「VEIN 官方」賣場。

### 3-5 確認清單
- [ ] 沒登入也能看到首頁、選購、抽獎、查驗
- [ ] Google 登入後右上角出現頭像
- [ ] 在管理後台上架一株植物（含照片），前台看得到
- [ ] 用另一個 Google 帳號：加入購物車、下單、參加抽獎
- [ ] 用另一個帳號申請成為賣家 → 管理後台「賣家審核」核准 → 他的商品出現在選購頁

### 3-6 開啟手機驗證
出價、下單、報名抽獎、開店之前都要驗證手機（一支手機只能綁一個帳號），**你自己進管理後台前也要驗證一次**。
1. Firebase 主控台 → Authentication →「登入方式」→「新增供應商」→ **電話** → 啟用 → 儲存。
2. 每封簡訊會產生少量費用，每天前 10 則免費。

### 3-7 開啟 Email 通知
通知會由伺服器（Cloud Functions）自動寄出，寄件人是你的 Gmail。
1. **產生 Gmail 應用程式密碼**：你的 Google 帳號要先開啟「兩步驟驗證」→ 到 myaccount.google.com/apppasswords → 名稱填 `VEIN` → 建立，會得到 16 碼密碼。
2. **存進 Secret Manager**：console.cloud.google.com →（選 vein 專案）→ 搜尋「Secret Manager」→ 啟用 API →「建立密鑰」兩次：
   - 名稱 `SMTP_USER`，值填你的 Gmail 地址
   - 名稱 `SMTP_PASS`，值填剛剛的 16 碼密碼（不要有空格）
3. **給部署鑰匙多兩個權限**：IAM 與管理 →「IAM」→ 找到 `github-deploy@…` → 鉛筆圖示 → 新增角色：
   - **編輯者**（Editor）
   - **Secret Manager 管理員**（Secret Manager Admin）
4. **打開部署開關**：GitHub repo → Settings → Secrets and variables → Actions →「Variables」分頁 →「New repository variable」：Name `DEPLOY_FUNCTIONS`，Value `true`。
5. 到 Actions 重新執行最新一次部署。第一次部署 Functions 大約要 3–5 分鐘；如果失敗並提到 Eventarc 或權限傳播，等 5 分鐘再重新執行一次通常就好了。

會寄出的通知：
- **買家**：下單確認、賣家接受訂單、出貨、訂單完成請評價、出價被超越、得標、抽獎中獎
- **賣家**：新訂單、新提問、競標結束、抽獎開獎結果、賣場審核通過
- **管理員**：有人申請開店

---

## 步驟 4：綁定自己的網域
1. 買網域（例如 `vein.tw`）。Cloudflare、Gandi 或台灣的網域商都可以。
2. Firebase 主控台 → Hosting →「新增自訂網域」→ 輸入網域，照畫面把 TXT 和 A 紀錄加到網域商的 DNS 設定。
3. 等它驗證完成（幾分鐘到一天），HTTPS 憑證會自動套上。
4. **一定要做**：Authentication →「設定」→「授權網域」→ 新增你的網域。沒加的話，在新網域上會無法登入。

---

## 之後怎麼改網站
- 修改都用 Pull Request：開了 PR 之後，GitHub 會自動部署一個**預覽網址**並留言在 PR 裡，確認沒問題再合併，合併後幾分鐘正式網站就更新。
- `firestore.rules`、`storage.rules` 改了之後，合併到 `main` 也會自動更新。

## 目前的限制（之後的步驟會處理）
- **時間用的是買家電腦的時間**：競標出價和抽獎報名都是。之後改用 Cloud Functions，由伺服器判斷時間、結標和開獎。
- **抽獎由賣家按「開獎」**：開獎時只抽完成手機驗證的參加者。
- **沒有線上付款**：要等決定收款方式（平台代收或賣家自己收）之後再接綠界或藍新。
- **網址是 `#/shop` 這種格式**：之後可以改成 `/shop`。
