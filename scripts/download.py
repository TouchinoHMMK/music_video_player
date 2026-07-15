"""GitHub Actions上でyt-dlpを使いメディアをダウンロードし、library.jsonを更新する。"""
import datetime
import glob
import json
import os
import sys

import yt_dlp

url = os.environ["MEDIA_URL"]
fmt = os.environ.get("MEDIA_FORMAT", "mp3")
tags = [t.strip() for t in os.environ.get("MEDIA_TAGS", "").replace("、", ",").split(",") if t.strip()]

MAX_BYTES = 95 * 1024 * 1024  # GitHubの1ファイル100MB制限に対する安全マージン

ydl_opts = {
    "outtmpl": "media/%(extractor)s-%(id)s.%(ext)s",
    "restrictfilenames": True,
    "noplaylist": True,
}

if os.path.exists("cookies.txt"):
    ydl_opts["cookiefile"] = "cookies.txt"

# ニコニコ動画のログイン(secretsに設定した場合のみ)
if "nicovideo.jp" in url and os.environ.get("NICO_EMAIL"):
    ydl_opts["username"] = os.environ["NICO_EMAIL"]
    ydl_opts["password"] = os.environ.get("NICO_PASSWORD", "")

if fmt == "mp3":
    ydl_opts["format"] = "bestaudio/best"
    ydl_opts["postprocessors"] = [
        {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
    ]
    ext = "mp3"
else:
    # 100MB制限に収まりやすいよう720pまでに制限
    ydl_opts["format"] = "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4]/best"
    ydl_opts["merge_output_format"] = "mp4"
    ext = "mp4"

with yt_dlp.YoutubeDL(ydl_opts) as ydl:
    info = ydl.extract_info(url, download=True)
    if "entries" in info:  # プレイリストURLだった場合は先頭のみ
        info = info["entries"][0]

video_id = info["id"]
title = info.get("title") or video_id

# 実際に生成されたファイルを特定
candidates = [p for p in glob.glob(f"media/*{video_id}*.{ext}")]
if not candidates:
    candidates = sorted(glob.glob(f"media/*.{ext}"), key=os.path.getmtime, reverse=True)[:1]
if not candidates:
    sys.exit(f"ERROR: ダウンロード後のファイルが見つかりません (media/*.{ext})")

path = candidates[0].replace("\\", "/")
size = os.path.getsize(path)
print(f"Downloaded: {path} ({size / 1024 / 1024:.1f} MB)")

if size > MAX_BYTES:
    os.remove(path)
    sys.exit(
        f"ERROR: ファイルサイズ {size / 1024 / 1024:.0f}MB がGitHubの上限(100MB)を超えます。"
        "mp3にするか、短い動画を選んでください。"
    )

# library.json を更新
with open("library.json", encoding="utf-8") as f:
    library = json.load(f)

library.setdefault("tracks", [])
library.setdefault("playlists", [])

track = {
    "id": f"{info.get('extractor_key', 'dl').lower()}-{video_id}-{ext}",
    "title": title,
    "type": "audio" if fmt == "mp3" else "video",
    "file": path,
    "tags": tags,
    "source": url,
    "addedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}

# 同じファイルの再ダウンロードは上書き(タグは既存を維持しつつ新規タグを追加)
existing = next((t for t in library["tracks"] if t.get("file") == path), None)
if existing:
    merged = list(dict.fromkeys((existing.get("tags") or []) + tags))
    existing.update(track)
    existing["tags"] = merged
else:
    library["tracks"].append(track)

with open("library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, ensure_ascii=False, indent=2)

print(f"library.json updated: {title}")
