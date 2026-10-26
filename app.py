import re
import shutil
import tempfile
import imageio_ffmpeg
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import yt_dlp
from flask import (
    Flask, jsonify, render_template, request,
    send_file, make_response
)
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024

MAX_DURATION = 60 * 60            # 1 ghanta se lambi video block
MAX_FILESIZE = 500 * 1024 * 1024  # 500 MB limit

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "music.youtube.com", "youtu.be",
}
INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}
YOUTUBE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")


def inspect_url(raw_url):
    raw_url = (raw_url or "").strip()

    if not raw_url or len(raw_url) > 2048:
        return None, "Please enter a valid video URL."

    try:
        parsed = urlparse(raw_url)
        port = parsed.port
    except ValueError:
        return None, "Invalid URL."

    if parsed.scheme != "https" or not parsed.hostname:
        return None, "Please use a valid HTTPS URL."

    if parsed.username or parsed.password:
        return None, "Invalid URL."

    if port not in (None, 443):
        return None, "Unsupported URL."

    host = parsed.hostname.lower().rstrip(".")

    if host in YOUTUBE_HOSTS:
        video_id = None

        if host == "youtu.be":
            video_id = parsed.path.strip("/").split("/")[0]
        elif parsed.path == "/watch":
            video_id = parse_qs(parsed.query).get("v", [None])[0]
        else:
            match = re.match(
                r"^/(?:shorts|embed|live)/([A-Za-z0-9_-]{11})", parsed.path
            )
            if match:
                video_id = match.group(1)

        if not video_id or not YOUTUBE_ID_PATTERN.fullmatch(video_id):
            return None, "YouTube video URL identify nahi hua."

        return {
            "platform": "YouTube",
            "url": f"https://www.youtube.com/watch?v={video_id}",
        }, None

    if host in INSTAGRAM_HOSTS:
        match = re.match(
            r"^/(p|reel|reels|tv)/([A-Za-z0-9_-]+)", parsed.path
        )
        if not match:
            return None, "Instagram Reel/Post URL identify nahi hua."

        kind, code = match.groups()
        return {
            "platform": "Instagram",
            "url": f"https://www.instagram.com/{kind}/{code}/",
        }, None

    return None, "Abhi sirf YouTube aur Instagram URLs supported hain."


def ydl_base():
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
    }
def fmt_size(f):
    return f.get("filesize") or f.get("filesize_approx") or 0


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/terms")
def terms():
    return render_template("legal_page.html", page="terms")


@app.get("/privacy")
def privacy():
    return render_template("legal_page.html", page="privacy")


@app.get("/sw.js")
def service_worker():
    response = make_response(
        send_file(
            app.static_folder + "/sw.js",
            mimetype="application/javascript"
        )
    )
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response

@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/api/inspect")
def inspect():
    data = request.get_json(silent=True) or {}
    result, error = inspect_url(data.get("url"))
    if error:
        return jsonify({"ok": False, "error": error}), 400

    try:
        with yt_dlp.YoutubeDL(ydl_base()) as ydl:
            info = ydl.extract_info(result["url"], download=False)
    except Exception:
        app.logger.exception(
            "Video info extraction failed for %s",
            result["platform"],
        )
        return jsonify({
            "ok": False,
            "error": "Video info nahi mili (private/blocked ho sakti hai).",
        }), 400

    if (info.get("duration") or 0) > MAX_DURATION:
        return jsonify({"ok": False, "error": "Video bahut lambi hai."}), 400

    formats = info.get("formats", [])

    # Best audio-only stream ki size (video ke saath merge hoti hai)
    audio_fmts = [
        f for f in formats
        if f.get("vcodec") == "none" and f.get("acodec") not in (None, "none")
    ]
    best_audio = max(audio_fmts, key=lambda f: f.get("abr") or 0, default=None)
    audio_size = fmt_size(best_audio) if best_audio else 0

    # Har height ke liye size nikaalo
    by_height = {}
    for f in formats:
        h = f.get("height")
        if not h or f.get("vcodec") == "none":
            continue
        size = fmt_size(f)
        if size and f.get("acodec") in (None, "none"):
            size += audio_size  # video-only hai, audio ki size jod do
        if h not in by_height or size > by_height[h]:
            by_height[h] = size

    qualities = [
        {"height": h, "size": by_height[h] or None}
        for h in sorted(by_height, reverse=True)
    ]

    result.update({
        "title": info.get("title"),
        "thumbnail": info.get("thumbnail"),
        "qualities": qualities,
        "best_size": qualities[0]["size"] if qualities else None,
        "audio_size": audio_size or None,
    })
    return jsonify({"ok": True, "data": result})


@app.post("/api/download")
def download():
    result, error = inspect_url(request.form.get("url"))
    if error:
        return jsonify({"ok": False, "error": error}), 400

    quality = request.form.get("quality", "best")

    if quality == "audio":
        fmt = "bestaudio[ext=m4a]/bestaudio"
    elif quality.isdigit() and int(quality) <= 4320:
        h = int(quality)
        fmt = f"bestvideo[height<={h}]+bestaudio/best[height<={h}]"
    else:
        fmt = "bestvideo+bestaudio/best"

    tmp = tempfile.mkdtemp(prefix="dl_")
    opts = ydl_base()
    opts.update({
        "format": fmt,
        "outtmpl": f"{tmp}/%(id)s.%(ext)s",
        "merge_output_format": "mp4",
        "max_filesize": MAX_FILESIZE,
    })

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(result["url"], download=True)
            path = ydl.prepare_filename(info)
            if not Path(path).exists():
                path = str(Path(path).with_suffix(".mp4"))
        if not Path(path).exists():
            raise FileNotFoundError(path)
    except Exception as e:
        print("Download error:", e)  # terminal me asli error dikhega
        shutil.rmtree(tmp, ignore_errors=True)
        return jsonify({"ok": False, "error": "Download fail ho gaya."}), 500

    name = secure_filename(info.get("title") or "video") or "video"
    response = send_file(
        path,
        as_attachment=True,
        download_name=name + Path(path).suffix,
    )
    response.call_on_close(lambda: shutil.rmtree(tmp, ignore_errors=True))
    return response


if __name__ == "__main__":
    app.run(debug=True)