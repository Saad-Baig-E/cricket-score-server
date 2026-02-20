const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ========== CRASH PROTECTION ==========
process.on('uncaughtException', (err) => {
    console.error('[CRASH GUARD] Uncaught Exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[CRASH GUARD] Unhandled Rejection (server kept alive):', err?.message || err);
});

// Support: command-line arg > environment variable > interactive prompt
let matchUrl = process.argv[2] || process.env.MATCH_URL;

// Enriched score data structure supporting both innings
let scoreData = {
  matchInfo: {
    description: '',
    format: '',
    status: 'Loading...',
    venue: '',
    state: '',
    toss: '',
    result: ''
  },
  team1: { name: '--', shortName: '--', id: 0 },
  team2: { name: '--', shortName: '--', id: 0 },
  currentInnings: 0,
  innings: [],
  miniscore: null,
  timestamp: new Date().toISOString(),
  error: null
};

const PORT = process.env.PORT || 5555;

// Extract match ID from Cricbuzz URL
function extractMatchId(matchUrl) {
  const match = matchUrl.match(/live-cricket-scores\/(\d+)|cricket-match\/(\d+)|\/(\d+)\//);
  return match ? (match[1] || match[2] || match[3]) : null;
}

// Fetch JSON from URL
function fetchUrl(fetchUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 8000);

    https.get(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 800000) res.destroy();
      });
      res.on('end', () => {
        clearTimeout(timeout);
        resolve(data);
      });
    }).on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

// Parse the React Server Components (RSC) payload from Cricbuzz page
function parseRSCPayload(html) {
  const result = {
    miniscore: null,
    matchHeader: null,
    commentary: [],
    matchScoreDetails: null
  };

  // Extract RSC push payloads manually (format: self.__next_f.push([1,"CONTENT"]))
  // Content contains escaped quotes \" and ends at unescaped "])
  const pushes = [];
  const marker = 'self.__next_f.push([1,"';
  let searchStart = 0;
  let loopCount = 0;
  const MAX_LOOPS = 5000;

  while (true) {
    if (++loopCount > MAX_LOOPS) { console.warn('[SAFETY] RSC parser hit iteration limit'); break; }
    const idx = html.indexOf(marker, searchStart);
    if (idx < 0) break;
    const contentStart = idx + marker.length;

    // Find closing "]) handling escaped quotes
    let pos = contentStart;
    let found = false;
    while (pos < html.length) {
      const endIdx = html.indexOf('"])', pos);
      if (endIdx < 0) break;
      // Count preceding backslashes
      let bs = 0;
      let check = endIdx - 1;
      while (check >= contentStart && html[check] === '\\') { bs++; check--; }
      if (bs % 2 === 0) {
        pushes.push(html.substring(contentStart, endIdx));
        found = true;
        searchStart = endIdx + 3;
        break;
      }
      pos = endIdx + 1;
    }
    if (!found) searchStart = idx + 1;
  }

  for (const raw of pushes) {
    if (raw.length < 500) continue;

    // Unescape: \" → " and \\ → \ and \n → newline
    const cleaned = raw.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');

    // Look for miniscore data
    if (cleaned.includes('"miniscore"') && !result.miniscore) {
      try {
        const miniIdx = cleaned.indexOf('"miniscore":');
        const objStart = cleaned.indexOf('{', miniIdx);
        let depth = 0, objEnd = objStart;
        for (let i = objStart; i < cleaned.length; i++) {
          if (cleaned[i] === '{') depth++;
          if (cleaned[i] === '}') depth--;
          if (depth === 0) { objEnd = i + 1; break; }
        }
        const miniJson = cleaned.substring(objStart, objEnd);
        const fixedJson = miniJson.replace(/"\$undefined"/g, 'null').replace(/\$undefined/g, 'null');
        result.miniscore = JSON.parse(fixedJson);
      } catch (e) {
        console.log('  Miniscore parse error:', e.message);
      }
    }

    // Look for matchHeader data
    if (cleaned.includes('"matchHeader"') && !result.matchHeader) {
      try {
        const headerIdx = cleaned.indexOf('"matchHeader":');
        const objStart = cleaned.indexOf('{', headerIdx);
        let depth = 0, objEnd = objStart;
        for (let i = objStart; i < cleaned.length; i++) {
          if (cleaned[i] === '{') depth++;
          if (cleaned[i] === '}') depth--;
          if (depth === 0) { objEnd = i + 1; break; }
        }
        const headerJson = cleaned.substring(objStart, objEnd);
        const fixedJson = headerJson.replace(/"\$undefined"/g, 'null').replace(/\$undefined/g, 'null');
        result.matchHeader = JSON.parse(fixedJson);
      } catch (e) {
        console.log('  MatchHeader parse error:', e.message);
      }
    }

    // Extract commentary entries
    if (cleaned.includes('"commType"') && cleaned.includes('"matchCommentary"')) {
      try {
        // Find the matchCommentary object
        const commIdx = cleaned.indexOf('"matchCommentary":');
        if (commIdx >= 0) {
          const objStart = cleaned.indexOf('{', commIdx);
          let depth = 0, objEnd = objStart;
          for (let i = objStart; i < cleaned.length; i++) {
            if (cleaned[i] === '{') depth++;
            if (cleaned[i] === '}') depth--;
            if (depth === 0) { objEnd = i + 1; break; }
          }
          const commJson = cleaned.substring(objStart, objEnd);
          const fixedJson = commJson.replace(/"\$undefined"/g, 'null').replace(/\$undefined/g, 'null');
          const commObj = JSON.parse(fixedJson);

          // Each key is a timestamp, value is the commentary entry
          for (const [ts, entry] of Object.entries(commObj)) {
            if (entry && entry.commType) {
              result.commentary.push({
                type: entry.commType,
                text: entry.commText ? entry.commText.replace(/<[^>]+>/g, '').substring(0, 300) : '',
                inningsId: entry.inningsId,
                event: entry.event,
                teamName: entry.teamName,
                timestamp: entry.timestamp || parseInt(ts),
                batsmanName: entry.batsmanDetails?.playerName || '',
                bowlerName: entry.bowlerDetails?.playerName || '',
                overSeparator: entry.overSeparator || null
              });
            }
          }
        }
      } catch (e) {
        console.log('  Commentary parse error:', e.message);
      }
    }
  }

  return result;
}

// Also try to extract scorecard data from the scorecard page
async function fetchScorecardPage(matchId) {
  try {
    // Try to get the scorecard page URL pattern
    const scUrl = matchUrl.replace('/live-cricket-scores/', '/live-cricket-scorecard/');
    const html = await fetchUrl(scUrl);

    const scorecard = { innings: [] };

    // Extract scorecard from RSC payload
    const pushRegex = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
    let match;

    while ((match = pushRegex.exec(html)) !== null) {
      const raw = match[1];
      if (raw.length < 1000) continue;

      // Look for scoreCard data
      if (raw.includes('"scoreCard"') || raw.includes('"batTeamDetails"')) {
        try {
          const cleaned = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

          // Extract innings scorecard data - look for batTeamDetails
          const batTeamRegex = /"batTeamDetails":\{"batTeamId":(\d+),"batTeamName":"([^"]+)","batTeamShortName":"([^"]+)"/g;
          let btMatch;
          while ((btMatch = batTeamRegex.exec(cleaned)) !== null) {
            // Found an innings batting details block
            const inningsBlock = cleaned.substring(btMatch.index - 200, Math.min(cleaned.length, btMatch.index + 10000));

            // Extract innings ID
            const innIdMatch = inningsBlock.match(/"scoreCardId":(\d+)|"inningsId":(\d+)/);
            const inningsId = innIdMatch ? parseInt(innIdMatch[1] || innIdMatch[2]) : scorecard.innings.length + 1;

            // Extract individual batsmen
            const batsmen = [];
            const batsmanRegex = /"batName":"([^"]+)"[^}]*?"runs":(\d+)[^}]*?"balls":(\d+)[^}]*?"fours":(\d+)[^}]*?"sixes":(\d+)[^}]*?"strikeRate":"?([0-9.]+)"?[^}]*?"outDesc":"([^"]*)"/g;
            let batMatch;
            const searchBlock = cleaned.substring(btMatch.index, Math.min(cleaned.length, btMatch.index + 15000));
            while ((batMatch = batsmanRegex.exec(searchBlock)) !== null) {
              batsmen.push({
                name: batMatch[1],
                runs: parseInt(batMatch[2]),
                balls: parseInt(batMatch[3]),
                fours: parseInt(batMatch[4]),
                sixes: parseInt(batMatch[5]),
                strikeRate: parseFloat(batMatch[6]),
                dismissal: batMatch[7]
              });
            }

            // Extract bowlers
            const bowlers = [];
            const bowlerRegex = /"bowlName":"([^"]+)"[^}]*?"overs":"?([0-9.]+)"?[^}]*?"maidens":(\d+)[^}]*?"runs":(\d+)[^}]*?"wickets":(\d+)[^}]*?"economy":"?([0-9.]+)"?/g;
            let bowlMatch;
            while ((bowlMatch = bowlerRegex.exec(searchBlock)) !== null) {
              bowlers.push({
                name: bowlMatch[1],
                overs: bowlMatch[2],
                maidens: parseInt(bowlMatch[3]),
                runs: parseInt(bowlMatch[4]),
                wickets: parseInt(bowlMatch[5]),
                economy: parseFloat(bowlMatch[6])
              });
            }

            // Extract extras
            const extrasMatch = searchBlock.match(/"extrasData":\{[^}]*"total":(\d+)[^}]*"bpieces":(\d+)[^}]*"legByes":(\d+)[^}]*"wpieces":(\d+)[^}]*"noBalls":(\d+)/);

            // Extract fall of wickets
            const fow = [];
            const fowRegex = /"fowId":(\d+)[^}]*?"batName":"([^"]+)"[^}]*?"wktNbr":(\d+)[^}]*?"wktOver":"?([0-9.]+)"?[^}]*?"wktRuns":(\d+)/g;
            let fowMatch;
            while ((fowMatch = fowRegex.exec(searchBlock)) !== null) {
              fow.push({
                wicket: parseInt(fowMatch[3]),
                batsman: fowMatch[2],
                score: parseInt(fowMatch[5]),
                overs: fowMatch[4]
              });
            }

            if (batsmen.length > 0 || bowlers.length > 0) {
              scorecard.innings.push({
                inningsId: inningsId,
                battingTeam: btMatch[2],
                battingTeamShort: btMatch[3],
                batsmen: batsmen,
                bowlers: bowlers,
                extras: extrasMatch ? {
                  total: parseInt(extrasMatch[1]),
                  byes: parseInt(extrasMatch[2]),
                  legByes: parseInt(extrasMatch[3]),
                  wides: parseInt(extrasMatch[4]),
                  noBalls: parseInt(extrasMatch[5])
                } : null,
                fallOfWickets: fow
              });
            }
          }
        } catch (e) {
          console.log('  Scorecard parse error:', e.message);
        }
      }
    }

    return scorecard;
  } catch (e) {
    console.log('  Could not fetch scorecard page:', e.message);
    return null;
  }
}

// Main fetch and parse function
async function fetchCricbuzzScore() {
  try {
    console.log(`\nFetching at ${new Date().toLocaleTimeString()}...`);

    const html = await fetchUrl(matchUrl);

    if (html.length < 1000) {
      console.log('  HTML too small, using cached data');
      return;
    }

    // Parse the RSC payload
    const rscData = parseRSCPayload(html);

    const mini = rscData.miniscore;
    const header = rscData.matchHeader;

    if (!mini && !header) {
      // Fallback: try og:title for basic score
      const ogMatch = html.match(/og:title[^>]*content="([^"]+)"/);
      if (ogMatch) {
        const ogTitle = ogMatch[1];
        console.log(`  Fallback og:title: ${ogTitle.substring(0, 80)}`);

        // Parse basic score from og:title
        const scoreMatch = ogTitle.match(/([A-Z]{2,4})\s+(\d+)(?:\/(\d+))?\s*(?:\(([0-9.]+)\))?.*?vs\s*([A-Z]{2,4})\s*(?:(\d+)(?:\/(\d+))?)?/);
        if (scoreMatch) {
          scoreData.matchInfo.status = ogTitle;
          scoreData.error = 'Limited data - using fallback parser';
        }
      }
      return;
    }

    // Build enriched score data from RSC payload

    // Match info from header
    if (header) {
      scoreData.matchInfo = {
        description: header.matchDescription || '',
        format: header.matchFormat || '',
        status: header.status || '',
        venue: '',
        state: header.state || '',
        toss: header.tossResults ? `${header.tossResults.tossWinnerName} won the toss and chose to ${header.tossResults.decision}` : '',
        result: header.result ? header.status : ''
      };

      // Extract team info
      if (header.team1) {
        scoreData.team1 = {
          name: header.team1.name || header.team1.teamName || '--',
          shortName: header.team1.shortName || header.team1.teamSName || '--',
          id: header.team1.id || header.team1.teamId || 0
        };
      }
      if (header.team2) {
        scoreData.team2 = {
          name: header.team2.name || header.team2.teamName || '--',
          shortName: header.team2.shortName || header.team2.teamSName || '--',
          id: header.team2.id || header.team2.teamId || 0
        };
      }
    }

    // Build innings data from matchScoreDetails
    const matchScore = mini?.matchScoreDetails;
    if (matchScore && matchScore.inningsScoreList) {
      scoreData.innings = matchScore.inningsScoreList.map(inn => ({
        id: inn.inningsId,
        battingTeamId: inn.batTeamId,
        battingTeam: inn.batTeamName,
        score: inn.score,
        wickets: inn.wickets,
        overs: inn.overs,
        balls: inn.ballNbr,
        isDeclared: inn.isDeclared,
        runRate: inn.overs > 0 ? (inn.score / inn.overs).toFixed(2) : '0.00'
      }));
      scoreData.currentInnings = matchScore.inningsScoreList.length;
    }

    // Enrich with miniscore live data
    if (mini) {
      scoreData.miniscore = {
        inningsId: mini.inningsId,
        battingTeam: mini.batTeam ? {
          id: mini.batTeam.teamId,
          score: mini.batTeam.teamScore,
          wickets: mini.batTeam.teamWkts
        } : null,
        batsmanStriker: mini.batsmanStriker ? {
          name: mini.batsmanStriker.name,
          runs: mini.batsmanStriker.runs,
          balls: mini.batsmanStriker.balls,
          fours: mini.batsmanStriker.fours,
          sixes: mini.batsmanStriker.sixes,
          strikeRate: mini.batsmanStriker.strikeRate
        } : null,
        batsmanNonStriker: mini.batsmanNonStriker && mini.batsmanNonStriker.id > 0 ? {
          name: mini.batsmanNonStriker.name,
          runs: mini.batsmanNonStriker.runs,
          balls: mini.batsmanNonStriker.balls,
          fours: mini.batsmanNonStriker.fours,
          sixes: mini.batsmanNonStriker.sixes,
          strikeRate: mini.batsmanNonStriker.strikeRate
        } : null,
        bowlerStriker: mini.bowlerStriker ? {
          name: mini.bowlerStriker.name,
          overs: mini.bowlerStriker.overs,
          maidens: mini.bowlerStriker.maidens,
          runs: mini.bowlerStriker.runs,
          wickets: mini.bowlerStriker.wickets,
          economy: mini.bowlerStriker.economy
        } : null,
        bowlerNonStriker: mini.bowlerNonStriker && mini.bowlerNonStriker.id > 0 ? {
          name: mini.bowlerNonStriker.name,
          overs: mini.bowlerNonStriker.overs,
          maidens: mini.bowlerNonStriker.maidens,
          runs: mini.bowlerNonStriker.runs,
          wickets: mini.bowlerNonStriker.wickets,
          economy: mini.bowlerNonStriker.economy
        } : null,
        overs: mini.overs,
        target: mini.target || 0,
        partnership: mini.partnerShip ? {
          runs: mini.partnerShip.runs,
          balls: mini.partnerShip.balls
        } : null,
        currentRunRate: mini.currentRunRate || 0,
        requiredRunRate: mini.requiredRunRate || 0,
        lastWicket: mini.lastWicket || null,
        recentOvers: mini.recentOvsStats || '',
        latestPerformance: mini.latestPerformance || [],
        event: mini.event || '',
        remRunsToWin: mini.remRunsToWin || 0,
        oversRemaining: mini.oversRem || null,
        status: matchScore?.customStatus || ''
      };

      // Extract over separator data if available
      if (mini.overSeparator) {
        scoreData.miniscore.overSummary = {
          overNumber: mini.overSeparator.overNumber,
          summary: mini.overSeparator.overSummary,
          batTeam: mini.overSeparator.batTeamObj,
          batStriker: mini.overSeparator.batStrikerObj,
          batNonStriker: mini.overSeparator.batNonStrikerObj,
          bowler: mini.overSeparator.bowlerObj
        };
      }
    }

    // Extract commentary ball-by-ball data for current over
    if (rscData.commentary.length > 0) {
      // Sort by timestamp descending (most recent first)
      rscData.commentary.sort((a, b) => b.timestamp - a.timestamp);

      // Get recent ball deliveries for the current over
      const currentInningsComm = rscData.commentary.filter(c =>
        c.inningsId === (mini?.inningsId || scoreData.currentInnings)
      );

      scoreData.recentCommentary = currentInningsComm.slice(0, 30).map(c => ({
        type: c.type,
        text: c.text ? c.text.replace(/<[^>]+>/g, '').substring(0, 200) : '',
        event: c.event,
        batsman: c.batsmanName,
        bowler: c.bowlerName
      }));
    }

    scoreData.timestamp = new Date().toISOString();
    scoreData.error = null;

    // Log summary
    console.log(`  Match: ${scoreData.matchInfo.description} [${scoreData.matchInfo.state}]`);
    if (scoreData.innings.length > 0) {
      scoreData.innings.forEach(inn => {
        console.log(`  Innings ${inn.id}: ${inn.battingTeam} ${inn.score}/${inn.wickets} (${inn.overs} ov)`);
      });
    }
    if (scoreData.miniscore) {
      const ms = scoreData.miniscore;
      if (ms.batsmanStriker) console.log(`  Bat*: ${ms.batsmanStriker.name} ${ms.batsmanStriker.runs}(${ms.batsmanStriker.balls})`);
      if (ms.bowlerStriker) console.log(`  Bowl: ${ms.bowlerStriker.name} ${ms.bowlerStriker.overs}-${ms.bowlerStriker.maidens}-${ms.bowlerStriker.runs}-${ms.bowlerStriker.wickets}`);
      if (ms.recentOvers) console.log(`  Recent: ${ms.recentOvers}`);
    }
    console.log(`  Status: ${scoreData.matchInfo.status || scoreData.miniscore?.status || 'Live'}`);

  } catch (e) {
    scoreData.error = 'Fetch error: ' + e.message;
    console.error('Fetch error:', e.message);
  }
}

// Serve HTML files from disk with localhost replaced by current host
function serveHtmlFile(res, filename) {
  const filePath = path.join(__dirname, filename);
  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('{"error":"File not found"}');
      return;
    }
    // Replace hardcoded localhost API URLs so overlays work on any host
    content = content.replace(
      /const API_URL\s*=\s*'http:\/\/localhost:5555\/score'/g,
      "const API_URL = (window.location.protocol === 'file:' ? 'http://localhost:5555' : window.location.origin) + '/score'"
    );
    content = content.replace(
      /const SERVER_URL\s*=\s*'http:\/\/localhost:5555\/score'/g,
      "const SERVER_URL = (window.location.protocol === 'file:' ? 'http://localhost:5555' : window.location.origin) + '/score'"
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
}

// HTTP server for JSON API
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = url.parse(req.url, true);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Safe JSON stringify helper
    let jsonStr;
    try { jsonStr = JSON.stringify(scoreData, null, 2); } catch(e) { jsonStr = '{"error":"serialize failed"}'; }

    if (parsedUrl.pathname === '/score') {
      res.writeHead(200);
      res.end(jsonStr);

    // Serve HTML overlay files publicly
    } else if (parsedUrl.pathname === '/overlay') {
      return serveHtmlFile(res, 'cricket_overlay.html');
    } else if (parsedUrl.pathname === '/stats') {
      return serveHtmlFile(res, 'cricket_stats.html');
    } else if (parsedUrl.pathname === '/livebar') {
      return serveHtmlFile(res, 'Record_with_live_bar.html');

    // Change match URL without redeploying (GET /set-match?url=CRICBUZZ_URL)
    } else if (parsedUrl.pathname === '/set-match') {
      const newUrl = parsedUrl.query.url;
      if (newUrl && newUrl.includes('cricbuzz.com')) {
        matchUrl = newUrl;
        console.log(`\n[MATCH CHANGED] New URL: ${matchUrl}`);
        // Fetch immediately with new URL
        try { await fetchCricbuzzScore(); } catch(e) {}
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, matchUrl: matchUrl, message: 'Match URL updated! Score will refresh shortly.' }));
      } else {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid URL. Must be a cricbuzz.com URL.' }));
      }

    // Get current match URL
    } else if (parsedUrl.pathname === '/get-match') {
      res.writeHead(200);
      res.end(JSON.stringify({ matchUrl: matchUrl || '' }));

    // Dashboard and root both serve the match control UI
    } else if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/dashboard') {
      return serveHtmlFile(res, 'dashboard.html');
    } else {
      res.writeHead(404);
      res.end('{"error":"Not found"}');
    }
  } catch (err) {
    console.error('[HTTP ERROR]', err.message);
    try { res.writeHead(500); res.end('{"error":"Internal server error"}'); } catch(e) {}
  }
});

// Start server and periodic updates
async function start() {
  // Match URL is optional at startup — user can set it from the dashboard
  if (matchUrl) {
    console.log(`Using match URL: ${matchUrl}\n`);
  } else {
    console.log('No match URL configured. Set one from the dashboard.\n');
  }

  server.on('error', (err) => {
    console.error('[SERVER ERROR]', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Kill the other process first.`);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nCricket Score Server v2 started on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    console.log(`Score API: http://localhost:${PORT}/score`);
    console.log(`Overlay:   http://localhost:${PORT}/overlay`);
    console.log(`Stats:     http://localhost:${PORT}/stats`);
    console.log(`Live Bar:  http://localhost:${PORT}/livebar\n`);
  });

  // Initial fetch if match URL is already set
  if (matchUrl) {
    console.log('Fetching initial data...\n');
    try { await fetchCricbuzzScore(); } catch(e) { console.error('Initial fetch error:', e.message); }
  }

  // Update every 2 seconds for ball-by-ball accuracy (guarded — never crashes the process)
  setInterval(async () => {
    if (matchUrl) {
      try { await fetchCricbuzzScore(); } catch(e) { console.error('[FETCH LOOP ERROR]', e.message); }
    }
  }, 2000);
}

start().catch(err => {
  console.error('Startup error:', err);
});
