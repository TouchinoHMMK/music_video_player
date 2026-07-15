# 🎵 MediaBox

GitHubをストレージにして複数デバイスで同期できる、音楽・動画プレイヤーPWA。

- 📱 スマホのホーム画面に追加してアプリのように使える(PWA)
- ☁️ 曲・動画・タグ・プレイリストをGitHubリポジトリで管理 → どの端末でも同じライブラリ
- ⬇️ YouTube / ニコニコ動画のURLを貼ると、GitHub Actionsがmp3/mp4に変換して保存
- 🏷 タグで整理、🗂 プレイリスト、🔀 シャッフル、🔁 リピート(全曲/1曲)

## セットアップ手順

### 1. GitHubリポジトリを作る

1. GitHubで新しいリポジトリを作成(例: `mediabox`)。**Public**推奨(Privateでも動くが再生がやや遅い)
2. このフォルダの中身をすべてプッシュする:

```bash
git remote add origin https://github.com/あなたのユーザー名/mediabox.git
git push -u origin main
```

### 2. GitHub Pagesを有効にする

リポジトリの **Settings → Pages → Branch: main / (root)** → Save。
数分後 `https://あなたのユーザー名.github.io/mediabox/` でアプリが開けます。

### 3. アクセストークン(PAT)を作る

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token
2. Repository access: 作ったリポジトリのみ選択
3. Permissions:
   - **Contents: Read and write**(ライブラリの読み書き)
   - **Actions: Read and write**(ダウンロードの実行)
4. 生成されたトークン(`github_pat_...`)をコピー

### 4. アプリの設定

アプリを開き **⚙設定** タブで以下を入力して保存:

| 項目 | 値 |
|---|---|
| ユーザー名 | GitHubのユーザー名 |
| リポジトリ名 | 例: `mediabox` |
| ブランチ | `main` |
| トークン | 手順3のPAT |

※ トークンは各端末のブラウザ内(localStorage)にのみ保存されます。スマホ・PCそれぞれで一度設定してください。

### 5. ホーム画面に追加(スマホ)

- **iPhone (Safari)**: 共有ボタン → 「ホーム画面に追加」
- **Android (Chrome)**: メニュー(⋮) → 「ホーム画面に追加」/「アプリをインストール」

## 使い方

- **＋追加タブ**: URLを貼って mp3(音声) / mp4(動画) を選び「ダウンロード開始」。GitHub Actionsが処理し、1〜3分後に「⟳同期」で反映されます。手元のファイルの直接アップロードも可能。
- **ライブラリ**: 曲をタップで再生。「⋮」からタグ編集・プレイリスト追加・削除。上部のタグチップで絞り込み。
- **プレイリスト**: 作成・通常再生・シャッフル再生。
- **プレイヤー**: 🔀シャッフル、🔁リピート(OFF→全曲→1曲)。

## 注意・制限

- **著作権とサイト利用規約**: YouTube等の規約では動画のダウンロードが制限されています。私的利用の範囲で、権利上問題のないコンテンツにのみ使用してください。
- **ファイルサイズ**: GitHubは1ファイル100MBまで。長い動画はmp3にするか短いものを選んでください(mp4は720pに制限済み)。リポジトリ全体も数GB以内が推奨です。
- **YouTubeのボット対策**: GitHub ActionsのIPからのダウンロードがブロックされてエラーになることがあります。その場合、ブラウザ拡張(Get cookies.txt など)で書き出したcookieをリポジトリの **Settings → Secrets → Actions** に `YTDLP_COOKIES` という名前で登録すると成功率が上がります。
- **ニコニコ動画のログインが必要な動画**: Secretsに `NICO_EMAIL` / `NICO_PASSWORD` を登録すると対応できます。
- **同期のタイムラグ**: ダウンロード完了後、GitHub Pagesへの反映に1分程度かかることがあります。

## 仕組み

```
┌─ スマホ/PC(PWA on GitHub Pages)
│    ├─ 再生・タグ・プレイリスト編集 → GitHub API で library.json を更新
│    └─ URLダウンロード指示 → GitHub Actions を起動(workflow_dispatch)
└─ GitHub リポジトリ
     ├─ library.json   … 曲メタデータ・タグ・プレイリスト
     ├─ media/*.mp3|mp4 … メディア本体(yt-dlpがコミット)
     └─ .github/workflows/download.yml … ダウンロード処理
```
