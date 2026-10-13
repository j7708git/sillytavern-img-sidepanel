# Image Side Panel（sillytavern-img-sidepanel）

一個 SillyTavern 擴充插件：聊天時**一鍵生成圖片**，圖片**不進聊天訊息**，而是顯示在輸入框右側的可收合側邊面板。生成走**獨立通道**（獨立 LLM profile 轉換提示詞 + ST 內建圖片生成），不會打斷角色扮演對話，也不會動到主聊天的 API 連線。

## 這是什麼

按一下輸入框工具列的 **⚡**，插件會把「最近的聊天訊息 + 角色卡描述」交給一個獨立的 LLM（預設自動挑 DeepSeek），轉成 ComfyUI 用的英文提示詞，再呼叫 SillyTavern 內建的圖片生成（`/imagine quiet=true`）出圖——圖片只出現在側邊面板，聊天視窗完全不受影響。

## 功能

- **⚡ 生成**：把最近幾條聊天訊息 + 角色卡描述轉成提示詞 → 呼叫 ST 內建生圖 → 顯示在側邊面板。全程非同步，不卡聊天。
- **🪄 面板開關**：工具列魔杖圖示展開/收合側邊面板。
- **浮動 / 固定兩種模式**：浮動面板可拖曳、縮放、雙擊標題重置位置；也可 📌 釘成嵌在聊天區上方的固定條。
- **◀ ▶ 歷史換頁**：每個聊天各自保留最近 200 張，可翻頁回看（含當時的提示詞）。
- **🔄 重新生成**：同提示詞換新隨機 seed 再出一張，原位更新。
- **📷 自動生圖**：開啟後每次 AI 回覆完整結束就自動「轉換 + 生成」一張；同一訊息 swipe/編輯不會重複觸發、上一張還在生成就跳過。
- **最終 prompt 顯示與複製**：面板顯示 ST 實際送進生成器的最終有效提示詞（含 ST 內建前墜合併與變數解析），一鍵複製。
- **設定面板**（ST 設定 → 擴充功能 → Image Side Panel）：
  - LLM Profile：提示詞轉換用的獨立連線 profile（留空 = 自動選 DeepSeek）
  - Context message count：取最近幾條訊息（1~10，預設 2）
  - Conversion template：多組轉換模板可下拉切換/新增/刪除/編輯，內建 `Anima`（Danbooru 標籤清單）與 `Krea 2`（英文自然語言描述）兩組

## 安裝

### 方法一：從 SillyTavern 擴充功能安裝（推薦）

1. 開啟 SillyTavern，點最上排的 **擴充功能**（Extensions）面板。
2. 點 **Install extension**。
3. 貼上本 repo 位址：
   ```
   https://github.com/j7708git/sillytavern-img-sidepanel
   ```
4. 安裝完成後**重新整理頁面**（F5）。工具列會多出 🪄 與 ⚡ 兩顆按鈕。

### 方法二：手動安裝（開發者）

把本目錄放進 `SillyTavern/public/scripts/extensions/sillytavern-img-sidepanel/`（開發中建議用 symlink 把 repo 目錄連進 ST 的 extensions 資料夾），然後重新整理 ST 頁面。

## 前置需求

- **SillyTavern 1.18**（鎖定版本開發，未測其他版本）
- ST 內建 **Image Generation** 擴充（`stable-diffusion`）已啟用，且設定為 **ComfyUI** source：
  - Source = ComfyUI、Server URL 指向你的 ComfyUI（例如 `http://<你的-ComfyUI-主機>:8000`）
  - Workflow 選擇一個 txt2img workflow
- **Connection Manager** 內至少一個 OpenAI 相容 profile（建議 DeepSeek 官方直連）供提示詞轉換使用
- ComfyUI 端有對應 checkpoint

## 使用

1. 在聊天中按 **⚡** → 面板自動展開，稍候出圖。
2. 想換一張同 prompt 的圖 → 面板標題列 **🔄**。
3. 翻歷史 → **◀ / ▶**；切換聊天時自動切到該聊天的歷史。
4. 面板收合 → 標題列 **▾** 或再按 🪄。
5. 想讓每次 AI 回覆結束後自動出一張圖 → 面板標題列 **📷** 開啟自動生圖（再按一次關閉）。

## 技術筆記（踩過的坑）

- **呼叫格式**：`/imagine quiet=true seed=-1 extend=false <prompt>`（STscript 具名參數在前、位置參數在後）。`quiet=true` 圖不進聊天；`seed=-1` 每次隨機。
- **`extend=false` 必須帶**：使用者若開了 ST 內建 SD 的 *Free Mode (LLM-Extended)*（`sd.free_extend`），SD 會用**主聊天連線**再擴寫一次 prompt——雙重 LLM、燒主 API 額度且繞過本插件的轉換。故每次呼叫鎖死。
- **`max_tokens=1000`**：DeepSeek 官方直連的推理模型，`max_tokens` 太小（實測 300）會把額度全花在 chain-of-thought 上，`content` 回空。
- **歷史儲存**：`extension_settings['img-sidepanel'].history`，以 chatId 分 key，每聊天上限 200 張（超出淘汰最舊）。圖片本體由 ST 存進 User Pictures。
- **最終有效 prompt**：ST 的 `/imagine`（FREE mode）會自動把 `sd.prompt_prefix` 以 `combinePrefixes(prefix, prompt, '{prompt}')` 合併、再跑 `substituteParams()`。面板顯示/複製的就是這個最終字串；歷史與 `lastResult` 仍存「轉換結果」，`🔄` 重新生成才不會把前墜套兩次。
- **角色卡無外觀描述**時，轉換模板會指示 LLM 依情境合理補足。
- **生成中 ⚡/🔄 會鎖定**（busy），避免連點爆 ComfyUI queue。

## 限制與 v2 展望

- 目前只支援 ComfyUI（依專案規格）
- 面板 prompt 唯讀（不可編輯）
- v2：img2img（以歷史圖為底重繪）、prompt 可編輯、生成進度細粒度顯示

## 授權

MIT。
