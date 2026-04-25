"""
Local HTTP receiver for the YT Tile Scraper extension.

Run:        python yt_receiver.py [--port 8765] [--out tiles.jsonl] [--no-dedup]
Endpoint:   POST http://127.0.0.1:8765/tiles  with JSON body {"tiles": [...], "page_url": "..."}
Output:     each newly-seen tile is written as one NDJSON line to stdout (or --out file).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import IO, Any


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class State:
    def __init__(self, out_fh: IO[str], dedup: bool, default_topic: str, llm_enabled: bool,
                 llm_model: str, llm_url: str, llm_api_key: str) -> None:
        self.out_fh = out_fh
        self.dedup = dedup
        self.default_topic = default_topic.strip()
        self.llm_enabled = llm_enabled
        self.llm_model = llm_model
        self.llm_url = llm_url
        self.llm_api_key = llm_api_key
        self.seen: set[str] = set()
        self.relevance: dict[str, bool] = {}
        self.lock = threading.Lock()
        self.total_received = 0
        self.total_accepted = 0


def text_blob(tile: dict[str, Any]) -> str:
    parts = [
        str(tile.get("title") or ""),
        str(tile.get("channel") or ""),
        str(tile.get("description") or ""),
    ]
    return " ".join(parts).lower()


def heuristic_is_irrelevant(tile: dict[str, Any], topic: str) -> bool:
    topic_words = [w for w in topic.lower().split() if len(w) >= 3]
    if not topic_words:
        return False
    blob = text_blob(tile)
    matches = sum(1 for w in topic_words if w in blob)
    return matches == 0


def llm_classify_irrelevant(state: State, topic: str, tiles: list[dict[str, Any]]) -> dict[str, bool]:
    if not state.llm_enabled or not state.llm_api_key or not tiles:
        return {}

    items: list[dict[str, str]] = []
    for t in tiles:
        vid = (t.get("video_id") or "").strip()
        if not vid:
            continue
        items.append({
            "video_id": vid,
            "title": str(t.get("title") or ""),
            "channel": str(t.get("channel") or ""),
            "description": str(t.get("description") or ""),
        })

    if not items:
        return {}

    prompt = (
        "You are a strict relevance filter for YouTube recommendations. "
        "Given a user topic and a list of videos, return ONLY JSON object: "
        "{\"irrelevant_ids\":[\"id1\",\"id2\"]}. "
        "Mark as irrelevant if the video is not about the topic, only weakly related, clickbait, or off-topic. "
        f"Topic: {topic}\n"
        f"Videos: {json.dumps(items, ensure_ascii=False)}"
    )
    payload = {
        "model": state.llm_model,
        "messages": [
            {"role": "system", "content": "Return valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
    }
    req = urllib.request.Request(
        state.llm_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {state.llm_api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        blocked = set(parsed.get("irrelevant_ids") or [])
        return {v["video_id"]: (v["video_id"] in blocked) for v in items}
    except (KeyError, ValueError, urllib.error.URLError, TimeoutError):
        return {}


def classify_tiles(state: State, topic: str, tiles: list[dict[str, Any]]) -> dict[str, bool]:
    llm_result = llm_classify_irrelevant(state, topic, tiles)
    out: dict[str, bool] = {}
    for t in tiles:
        vid = (t.get("video_id") or "").strip()
        if not vid:
            continue
        if vid in llm_result:
            out[vid] = llm_result[vid]
        else:
            out[vid] = heuristic_is_irrelevant(t, topic)
    return out


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path in ("/", "/health"):
                body = json.dumps({
                    "ok": True,
                    "received": state.total_received,
                    "accepted": state.total_accepted,
                    "unique": len(state.seen),
                    "llm_enabled": state.llm_enabled,
                    "default_topic": state.default_topic,
                }).encode("utf-8")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self._cors()
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/tiles":
                self.send_response(404)
                self._cors()
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                payload: dict[str, Any] = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError as e:
                self._reply(400, {"ok": False, "error": f"bad json: {e}"})
                return

            tiles = payload.get("tiles") or []
            if not isinstance(tiles, list):
                self._reply(400, {"ok": False, "error": "tiles must be an array"})
                return

            topic = str(payload.get("topic") or state.default_topic).strip()

            received_at = iso_now()
            accepted = 0
            blocked_video_ids: list[str] = []
            new_for_classify: list[dict[str, Any]] = []
            all_video_ids: list[str] = []
            with state.lock:
                state.total_received += len(tiles)
                for t in tiles:
                    if not isinstance(t, dict):
                        continue
                    video_id = (t.get("video_id") or "").strip()
                    key = video_id or (t.get("url") or "").strip()
                    if video_id:
                        all_video_ids.append(video_id)
                    if state.dedup:
                        if not key or key in state.seen:
                            if video_id and state.relevance.get(video_id):
                                blocked_video_ids.append(video_id)
                            continue
                        state.seen.add(key)
                    t.setdefault("scraped_at", received_at)
                    t["received_at"] = received_at
                    state.out_fh.write(json.dumps(t, ensure_ascii=False) + "\n")
                    accepted += 1
                    if video_id:
                        new_for_classify.append(t)

                if topic and new_for_classify:
                    verdicts = classify_tiles(state, topic, new_for_classify)
                    state.relevance.update(verdicts)

                for vid in all_video_ids:
                    if state.relevance.get(vid):
                        blocked_video_ids.append(vid)

                state.out_fh.flush()
                state.total_accepted += accepted

            print(f"[receiver] received={len(tiles)} accepted={accepted} "
                  f"total_unique={len(state.seen)}", file=sys.stderr)
            self._reply(200, {
                "ok": True,
                "received": len(tiles),
                "accepted": accepted,
                "topic": topic,
                "blocked_video_ids": sorted(set(blocked_video_ids)),
            })

        def _reply(self, status: int, obj: dict) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args, **_kwargs) -> None:
            # Silence default access log; we print our own.
            pass

    return Handler


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Receive YouTube tile records from the YT Tile Scraper extension.")
    p.add_argument("--host", default="127.0.0.1", help="Bind host (default 127.0.0.1).")
    p.add_argument("--port", type=int, default=8765, help="Bind port (default 8765).")
    p.add_argument("--out", default=None, help="Append NDJSON to this file instead of stdout.")
    p.add_argument("--no-dedup", action="store_true", help="Do not dedupe by video_id (write every tile).")
    p.add_argument("--topic", default="", help="Default relevance topic if extension does not send one.")
    p.add_argument("--llm", action="store_true", help="Enable OpenAI-compatible LLM relevance classification.")
    p.add_argument("--llm-model", default="gpt-4o-mini", help="Model name for --llm.")
    p.add_argument("--llm-url", default="https://api.openai.com/v1/chat/completions",
                   help="OpenAI-compatible chat completions URL for --llm.")
    return p.parse_args(argv)


def main() -> int:
    args = parse_args()
    out_fh: IO[str] = open(args.out, "a", encoding="utf-8") if args.out else sys.stdout
    llm_api_key = os.environ.get("OPENAI_API_KEY", "")
    state = State(
        out_fh,
        dedup=not args.no_dedup,
        default_topic=args.topic,
        llm_enabled=args.llm,
        llm_model=args.llm_model,
        llm_url=args.llm_url,
        llm_api_key=llm_api_key,
    )
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    print(f"[receiver] listening on http://{args.host}:{args.port}/tiles "
          f"(dedup={'on' if state.dedup else 'off'}, llm={'on' if state.llm_enabled else 'off'}, "
          f"out={'stdout' if out_fh is sys.stdout else args.out})",
          file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[receiver] stopping...", file=sys.stderr)
    finally:
        server.server_close()
        if out_fh is not sys.stdout:
            out_fh.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
