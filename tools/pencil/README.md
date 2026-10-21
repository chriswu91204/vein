# 色鉛筆風格轉檔

把照片或影片轉成色鉛筆手繪風（主頁 `public/m/` 的素材就是這樣做出來的）。

需要：Python 3、`opencv-python`、`numpy`、`ffmpeg`。

```bash
# 照片
python3 pencil.py 原圖.jpg 輸出.jpg [線條粗細倍率，預設 1]
# 影片（8 fps 手繪動畫感，第一格存成封面圖）
python3 video.py 原片.mov 輸出.mp4 封面.jpg
```
