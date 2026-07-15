"""GitHub Actions上でyt-dlpを使いメディアをダウンロードし、library.jsonを更新する。

- 単体の動画URL      → その1本だけダウンロード
- プレイリストのURL  → 中の曲をまとめてダウンロード(最大 PLAYLIST_LIMIT 件)
- 同じ名前の曲が既にライブラリにある場合はダウンロードせずスキップ(重複防止)
- 一度取得した動画は archive.txt で記録し、次回以降は再ダウンロードしない
"""
import datetime
import glob
import json
import os
import sys

import yt_dlp

url = os.environ["MEDIA_URL"].strip()
fmt = os.environ.get("MEDIA_FORMAT", "mp3")
tags = [t.strip() for t in os.environ.get("MEDIA_TAGS", "").replace("、", ",").split(",") if t.strip()]

MAX_BYTES = 95 * 1024 * 1024   # GitHubの1ファイル100MB制限に対する安全マージン
PLAYLIST_LIMIT = 30            # プレイリストで一度に取得する最大件数
ARCHIVE = "media/archive.txt"  # 取得済み動画IDの記録(重複ダウンロード防止)
ext = "mp3" if fmt == "mp3" else "mp4"

# ---- 単体URLかプレイリストURLかを判定 ----
low = url.lower()
is_single = any(k in low for k in [
    "watch?v=", "youtu.be/", "nicovideo.jp/watch/", "/watch/", "nico.ms/",
])
is_playlist = (not is_single) and any(k in low for k in [
    "list=", "playlist", "/mylist/", "/series/", "/channel/", "/user/", "/@",
])

# ---- 既存ライブラリを読み込み(重複判定に使う) ----
with open("library.json", encoding="utf-8") as f:
    library = json.load(f)
library.setdefault("tracks", [])
library.setdefault("playlists", [])

existing_titles = {(t.get("title") or "").strip().lower() for t in library["tracks"]}
existing_files = {t.get("file") for t in library["tracks"]}


def match_filter(info_dict, *, incomplete=False):
    """同じ名前の曲が既にある場合、ダウンロード前にスキップする。"""
    title = (info_dict.get("title") or "").strip().lower()
    if title and title in existing_titles:
        return f"既に同名の曲があるためスキップ: {info_dict.get('title')}"
    return None


ydl_opts = {
    "outtmpl": "media/%(extractor)s-%(id)s.%(ext)s",
    "restrictfilenames": True,
    "noplaylist": not is_playlist,
    "download_archive": ARCHIVE,
    "ignoreerrors": is_playlist,   # プレイリストは一部失敗しても続行
    "match_filter": match_filter,
}
if is_playlist:
    ydl_opts["playlistend"] = PLAYLIST_LIMIT

if os.path.exists("cookies.txt"):
    ydl_opts["cookiefile"] = "cookies.txt"

# ニコニコ動画のログイン(secretsに設定した場合のみ)
if "nicovideo.jp" in low and os.environ.get("NICO_EMAIL"):
    ydl_opts["username"] = os.environ["NICO_EMAIL"]
    ydl_opts["password"] = os.environ.get("NICO_PASSWORD", "")

if fmt == "mp3":
    ydl_opts["format"] = "bestaudio/best"
    ydl_opts["postprocessors"] = [
        {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
    ]
else:
    # 100MB制限に収まりやすいよう720pまでに制限
    ydl_opts["format"] = "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4]/best"
    ydl_opts["merge_output_format"] = "mp4"

print(f"URL: {url}")
print(f"モード: {'プレイリスト(最大' + str(PLAYLIST_LIMIT) + '件)' if is_playlist else '単体'} / 形式: {ext}")

with yt_dlp.YoutubeDL(ydl_opts) as ydl:
    info = ydl.extract_info(url, download=True)

if info is None:
    sys.exit(
        "ERROR: ダウンロードできませんでした。"
        "Cookie未設定によるボット判定、年齢制限、非公開/削除済みなどが考えられます。"
    )

# 単体・プレイリストどちらも entries のリストに正規化
entries = info["entries"] if isinstance(info, dict) and "entries" in info else [info]
entries = [e for e in entries if e]


def find_file(entry):
    """ダウンロードされた実ファイルのパスを特定する。"""
    for rd in entry.get("requested_downloads") or []:
        fp = rd.get("filepath")
        if fp and os.path.exists(fp):
            return fp.replace("\\", "/")
    vid = entry.get("id", "")
    cands = [p for p in glob.glob(f"media/*{vid}*.{ext}") if os.path.exists(p)]
    return cands[0].replace("\\", "/") if cands else None


added = 0
skipped = 0
for e in entries:
    path = find_file(e)
    if not path:
        # archive済みでスキップ、match_filterで除外、または取得失敗
        skipped += 1
        continue

    title = (e.get("title") or e.get("id") or "").strip()
    if title.lower() in existing_titles or path in existing_files:
        skipped += 1
        continue

    size = os.path.getsize(path)
    if size > MAX_BYTES:
        os.remove(path)
        print(f"SKIP(容量超過 {size / 1024 / 1024:.0f}MB): {title}")
        skipped += 1
        continue

    video_id = e.get("id", "")
    library["tracks"].append({
        "id": f"{(e.get('extractor_key') or 'dl').lower()}-{video_id}-{ext}",
        "title": title or video_id,
        "type": "audio" if fmt == "mp3" else "video",
        "file": path,
        "tags": list(tags),
        "source": e.get("webpage_url") or url,
        "addedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    existing_titles.add(title.lower())
    existing_files.add(path)
    added += 1
    print(f"追加: {title} ({size / 1024 / 1024:.1f} MB)")

with open("library.json", "w", encoding="utf-8") as f:
    json.dump(library, f, ensure_ascii=False, indent=2)

print(f"完了: 追加 {added} 件 / スキップ {skipped} 件")

if added == 0 and skipped > 0:
    print("(すべて既存または重複のため、新規追加はありませんでした)")
