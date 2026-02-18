# 🏏 Cricket Score Server for OBS

A Node.js server that scrapes live cricket scores from Cricbuzz and serves them as a JSON API for OBS overlays.

## Features

- **Scrapes Cricbuzz** live match data (match title, score, status)
- **JSON API** at `localhost:5555/score`
- **Auto-refresh** every 10 seconds
- **OBS Browser Source ready** with included HTML overlay
- **No external dependencies** except jsdom
- **CORS enabled** for browser overlay

## Setup

### 1. Install Dependencies (one time)

```bash
npm install
```

This installs `jsdom` for HTML parsing.

### 2. Run the Server

**Option A: Pass URL as argument**
```bash
node live_score_server.js "https://www.cricbuzz.com/live-cricket-scores/114526/gt-vs-csk"
```

**Option B: Provide URL when prompted**
```bash
node live_score_server.js
# Then paste Cricbuzz match URL
```

### 3. Server Output

```
🏏 Cricket Score Server started on http://localhost:5555
📊 Score API: http://localhost:5555/score
🌐 Dashboard: http://localhost:5555/

Fetching initial data...
✓ Score updated at 12:34:56 PM
  Match: GT vs CSK
  Score: 156/7
  Status: Over 18.3 of 20 overs
```

## API Usage

### Get Current Score

```bash
curl http://localhost:5555/score
```

**Response:**
```json
{
  "match": "Gujarat Titans vs Chennai Super Kings",
  "score": "156/7",
  "status": "Over 18.3 of 20 overs",
  "timestamp": "2024-02-15T12:34:56.789Z",
  "error": null
}
```

## Using with OBS

### 1. Get Overlay File Path

The overlay file `cricket_overlay.html` is already created. Get its full path:
```bash
pwd
# /Users/user/Downloads/files
# So the file:// URL is: file:///Users/user/Downloads/files/cricket_overlay.html
```

### 2. Add Browser Source in OBS

1. In OBS, click **"+"** to add a new source
2. Select **"Browser"**
3. In the "URL" field, paste: `file:///Users/user/Downloads/files/cricket_overlay.html`
4. Set width: `450` and height: `300` (adjust as needed)
5. Click OK

### 3. Position the Overlay

The overlay appears in the top-right corner by default. You can:
- Drag it to reposition
- Resize it using the corner handles
- Edit `cricket_overlay.html` to change the styling

## Customizing the Overlay

Edit `cricket_overlay.html` to change:

- **Colors**: Modify the `linear-gradient` in `.score-container`
- **Size**: Change `min-width` in `.score-container`
- **Position**: Change `justify-content` and `align-items` in `body`
- **Font size**: Adjust `.score-display`, `.match-title`, etc.

## Finding a Cricbuzz Match URL

1. Go to https://www.cricbuzz.com/cricket/live-scores
2. Click on any live match
3. Copy the URL from your browser
4. Paste it when starting the server

Example URLs:
- `https://www.cricbuzz.com/live-cricket-scores/114526/gt-vs-csk`
- `https://www.cricbuzz.com/live-cricket-scores/67890/ind-vs-pak`

## Troubleshooting

### "Cannot connect to server" in overlay
- Make sure `node live_score_server.js` is running
- Check that port 5555 is not in use: `lsof -i :5555`
- Try restarting the server

### Score not updating
- Verify the Cricbuzz URL is valid and the match is live
- Check the console output of the server for errors
- Try opening `http://localhost:5555/` in your browser to see raw JSON

### OBS shows blank overlay
- Make sure you used `file://` path, not `http://`
- Check browser console in OBS (View → Developer Tools → Console)
- Verify the overlay HTML file exists at the path

## Technical Details

- **Server**: Node.js HTTP server on port 5555
- **Parser**: JSDOM for DOM parsing
- **Scraping**: CSS selectors to find match title, score, status
- **Update frequency**: Every 10 seconds
- **Overlay**: Vanilla JavaScript fetch API, auto-refresh

## Performance Notes

- The server uses ~50MB memory
- Each Cricbuzz request takes ~2-5 seconds
- Overlay fetch adds ~100-200ms latency
- Total refresh cycle: ~3-7 seconds

## License

MIT
