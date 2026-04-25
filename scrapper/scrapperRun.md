  Window 1 — start the receiver (Python):
  scrapper\.venv\Scripts\Activate.ps1
  python scrapper\yt_receiver.py --out tiles.jsonl
  Leave it running. You should see:
  [receiver] listening on http://127.0.0.1:8765/tiles ...

  Optional topic-aware filtering with LLM:
  $env:OPENAI_API_KEY="your_api_key"
  python scrapper\yt_receiver.py --out tiles.jsonl --llm --topic "python interview prep"
  Notes:
  - The popup can also send topic dynamically via "Focus topic".
  - Without --llm, receiver uses a keyword heuristic fallback.

  Window 2 — sanity check (optional):
  curl http://127.0.0.1:8765/health
  Returns JSON like {"ok": true, "received": 0, ...}.

  One-time: load the extension into your normal Chrome:
  1. Open chrome://extensions.
  2. Toggle Developer mode on (top-right).
  3. Click Load unpacked → select D:\hackathonn\LockIn\scrapper\extension.
  4. Pin "YT Tile Scraper" to the toolbar.

  To scrape:
  1. In your normal Chrome, go to any YouTube page (home, search, channel, watch, subscriptions).
  2. Click the YT Tile Scraper icon, set "Focus topic" (optional), then click Scrape now.
  3. Popup status shows Sent N tiles. New: M. Blocked on page: K.
  4. Window 1 prints [receiver] received=N accepted=M ...
  5. New tiles append as NDJSON to D:\hackathonn\LockIn\tiles.jsonl.