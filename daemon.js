#!/usr/bin/env node
// daemon.js — keystroke daemon for the live OCR bot.
//
//   node daemon.js                                       # live, no focus guard
//   node daemon.js --dry-run                             # logs the command, no keystrokes
//   node daemon.js --app="Google Chrome" --tab="Poker"   # only fire when Chrome is
//                                                          frontmost AND the front
//                                                          tab title contains "Poker"
//
// API:
//   POST http://localhost:9001/act
//   body: { action: 'fold'|'call'|'check'|'raise'|'bet'|'allin'|'foldview',
//           sliderTicks?: number,   // adjust slider before raising (+ = up, - = down)
//           label?: string }        // freeform tag echoed in the log
//   → 200 {ok:true} on success
//   → 423 {ok:false, error:'focus mismatch', frontmost, tabTitle} when guarded
//
//   GET /focus  → current frontmost app + (for supported browsers) front-tab title
//   GET /health → daemon status
//
// Safety: with --app set, the daemon refuses to send keystrokes unless the
// frontmost macOS app matches. With --tab also set, the tab title must match.
// Without either, the daemon fires blindly (only use in --dry-run or trusted
// environments).

'use strict';

const http = require('http');
const { exec } = require('child_process');

const PORT = 9001;
const DRY_RUN = process.argv.includes('--dry-run');
const APP_GUARD = (process.argv.find(a => a.startsWith('--app=')) || '').slice(6) || null;
const TAB_GUARD = (process.argv.find(a => a.startsWith('--tab=')) || '').slice(6) || null;

// AppleScript snippets to query window/tab state for each supported browser.
const BROWSER_TAB_AS = {
  'Google Chrome':       'tell application "Google Chrome" to get title of active tab of front window',
  'Brave Browser':       'tell application "Brave Browser" to get title of active tab of front window',
  'Microsoft Edge':      'tell application "Microsoft Edge" to get title of active tab of front window',
  'Arc':                 'tell application "Arc" to get title of active tab of front window',
  'Safari':              'tell application "Safari" to get name of current tab of front window',
  'Firefox':             null, // Firefox doesn't expose tab titles via AppleScript without an extension
};

async function frontmostApp() {
  const out = await runOsascriptRaw(
    'tell application "System Events" to get name of first application process whose frontmost is true'
  );
  return out.trim();
}

async function frontTabTitle(app) {
  const script = BROWSER_TAB_AS[app];
  if (!script) return null;
  try { return (await runOsascriptRaw(script)).trim(); }
  catch (_) { return null; }
}

async function focusState() {
  const app = await frontmostApp();
  const tab = await frontTabTitle(app);
  return { app, tab };
}

const BROWSERS_WITH_TABS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc'];

async function getActiveTabIdx(app) {
  if (!BROWSERS_WITH_TABS.includes(app)) return null;
  try {
    const safeApp = app.replace(/"/g, '\\"');
    const out = await runOsascriptRaw(
      `tell application "${safeApp}" to get active tab index of front window`
    );
    const n = parseInt((out || '').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

async function switchBackTo(original) {
  if (!original || !original.app) return false;
  const safeApp = original.app.replace(/"/g, '\\"');
  try {
    if (BROWSERS_WITH_TABS.includes(original.app) && original.tabIdx != null) {
      await runOsascriptRaw([
        `tell application "${safeApp}"`,
        `  activate`,
        `  if (count of windows) > 0 then`,
        `    try`,
        `      set active tab index of front window to ${original.tabIdx}`,
        `      set index of front window to 1`,
        `    end try`,
        `  end if`,
        `end tell`,
      ].join('\n'));
    } else {
      await runOsascriptRaw(`tell application "${safeApp}" to activate`);
    }
    return true;
  } catch (_) { return false; }
}

function buildNavigationScript(app, tabPattern) {
  // Returns an AppleScript that brings the target app forward and (for
  // supported browsers) selects a tab whose title matches the pattern.
  if (!app) return null;
  const safeApp = app.replace(/"/g, '\\"');
  const browsersWithTabs = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc'];
  if (browsersWithTabs.includes(app)) {
    if (!tabPattern) return `tell application "${safeApp}" to activate`;
    const safeTab = tabPattern.replace(/"/g, '\\"');
    return [
      `tell application "${safeApp}"`,
      `  activate`,
      `  set found to false`,
      `  repeat with w in windows`,
      `    set tabIdx to 1`,
      `    repeat with t in tabs of w`,
      `      try`,
      `        if (title of t) contains "${safeTab}" then`,
      `          set active tab index of w to tabIdx`,
      `          set index of w to 1`,
      `          set found to true`,
      `          exit repeat`,
      `        end if`,
      `      end try`,
      `      set tabIdx to tabIdx + 1`,
      `    end repeat`,
      `    if found then exit repeat`,
      `  end repeat`,
      `end tell`,
    ].join('\n');
  }
  // Native or unsupported-tab apps: just activate.
  return `tell application "${safeApp}" to activate`;
}

function focusMatches(app, tab) {
  if (APP_GUARD && app !== APP_GUARD) return false;
  if (TAB_GUARD) {
    if (tab == null) return false;
    if (!tab.toLowerCase().includes(TAB_GUARD.toLowerCase())) return false;
  }
  return true;
}

async function focusCheck() {
  // If no guard configured, allow with no switch-back context.
  if (!APP_GUARD && !TAB_GUARD) return { ok: true, original: null };
  let { app, tab } = await focusState();
  if (focusMatches(app, tab)) return { ok: true, app, tab, original: null };

  // Mismatch — try to auto-navigate to the target before failing. Capture
  // the originally-focused app/tab so we can switch back after firing.
  const original = { app, tabIdx: await getActiveTabIdx(app) };
  const navScript = buildNavigationScript(APP_GUARD, TAB_GUARD);
  if (navScript) {
    log(`AUTO-NAV → bringing ${APP_GUARD}${TAB_GUARD ? ` (tab matching "${TAB_GUARD}")` : ''} to front (will return to ${original.app}${original.tabIdx ? ` tab ${original.tabIdx}` : ''})`);
    try {
      await runOsascriptRaw(navScript);
      // Let the OS finish processing the focus change before re-checking.
      await new Promise((r) => setTimeout(r, 200));
      const re = await focusState();
      app = re.app; tab = re.tab;
      if (focusMatches(app, tab)) return { ok: true, app, tab, autoNavigated: true, original };
    } catch (e) {
      log(`AUTO-NAV failed: ${e.message}`);
    }
  }

  // Still wrong — refuse.
  if (APP_GUARD && app !== APP_GUARD) {
    return { ok: false, reason: `app ${JSON.stringify(app)} != ${JSON.stringify(APP_GUARD)}`, app, tab };
  }
  return { ok: false, reason: `tab ${JSON.stringify(tab)} missing ${JSON.stringify(TAB_GUARD)}`, app, tab };
}

// macOS key codes we need. See:
//   https://eastmanreference.com/complete-list-of-applescript-key-codes
const KC_LEFT  = 123;
const KC_RIGHT = 124;
const KC_DOWN  = 125;
const KC_UP    = 126;

// action → AppleScript line
function scriptFor(action, sliderTicks) {
  // bet sizing via slider: send Ctrl+'+' or Ctrl+'-' N times before the raise key.
  const sliderLines = [];
  if (sliderTicks && Number.isFinite(sliderTicks)) {
    const key = sliderTicks > 0 ? '+' : '-';
    const n = Math.min(50, Math.abs(sliderTicks)); // safety cap
    for (let i = 0; i < n; i++) {
      sliderLines.push(`keystroke "${key}" using control down`);
      sliderLines.push('delay 0.02');
    }
  }
  let actionLine;
  switch (action) {
    case 'fold':     actionLine = `key code ${KC_LEFT} using command down`; break;
    case 'check':
    case 'call':     actionLine = `key code ${KC_DOWN} using command down`; break;
    case 'bet':
    case 'raise':    actionLine = `key code ${KC_RIGHT} using command down`; break;
    case 'double':   actionLine = `key code ${KC_UP} using command down`; break;
    case 'foldview': actionLine = `key code ${KC_LEFT} using {command down, shift down}`; break;
    case 'allin':    actionLine = `keystroke "0" using control down`; break;
    default:         return null;
  }
  const lines = ['tell application "System Events"', ...sliderLines, actionLine, 'end tell'];
  return lines.join('\n');
}

function runOsascript(script) {
  return runOsascriptRaw(script);
}
function runOsascriptRaw(script) {
  return new Promise((resolve, reject) => {
    const args = script.split('\n').flatMap((line) => ['-e', line]);
    exec(`osascript ${args.map((a) => JSON.stringify(a)).join(' ')}`,
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
  });
}

function ts() {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}
function log(...a) { console.log(`[${ts()}]`, ...a); }

const server = http.createServer(async (req, res) => {
  // CORS pre-flight + permissive headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, dryRun: DRY_RUN, port: PORT, ts: Date.now(),
                                   appGuard: APP_GUARD, tabGuard: TAB_GUARD }));
  }

  if (req.method === 'GET' && req.url === '/focus') {
    try {
      const f = await focusState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...f }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (req.method !== 'POST' || req.url !== '/act') {
    res.writeHead(404); return res.end('not found');
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 1024) req.destroy(); });
  req.on('end', async () => {
    let cmd;
    try { cmd = JSON.parse(body); }
    catch { res.writeHead(400); return res.end('bad json'); }

    const { action, sliderTicks, label } = cmd;
    const script = scriptFor(action, sliderTicks);
    if (!script) {
      log('REJECT unknown action:', action);
      res.writeHead(400); return res.end('unknown action');
    }

    const tag = label ? `[${label}]` : '';

    // Focus guard — runs in live mode only; dry-run skips so you can test
    // config. Hoisted so switch-back logic below can read guard.original.
    let guard = { ok: true, original: null };
    if (!DRY_RUN) {
      try {
        guard = await focusCheck();
        if (!guard.ok) {
          log(`BLOCKED ${action} ${tag} — ${guard.reason}`);
          res.writeHead(423, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'focus mismatch',
                                          reason: guard.reason, app: guard.app, tab: guard.tab }));
        }
      } catch (e) {
        log(`BLOCKED ${action} ${tag} — focus check failed: ${e.message}`);
        res.writeHead(500); return res.end('focus check failed');
      }
    }

    if (DRY_RUN) {
      log(`DRY ${action}${sliderTicks ? ` slider${sliderTicks > 0 ? '+' : ''}${sliderTicks}` : ''} ${tag}`);
      log('  script:\n' + script.split('\n').map(l => '    ' + l).join('\n'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, dryRun: true }));
    }

    // Stash whatever original-tab context the focus check captured so we can
    // switch back after the keystroke lands.
    const original = guard.original;

    try {
      log(`FIRE ${action}${sliderTicks ? ` slider${sliderTicks > 0 ? '+' : ''}${sliderTicks}` : ''} ${tag}`);
      await runOsascript(script);
      // Small settle delay so the receiving app finishes its keystroke handler
      // before we yank focus away.
      if (original) {
        await new Promise((r) => setTimeout(r, 120));
        const back = await switchBackTo(original);
        if (back) {
          log(`SWITCH-BACK → ${original.app}${original.tabIdx ? ` tab ${original.tabIdx}` : ''}`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, switchedBack: !!original }));
    } catch (e) {
      log('ERROR', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`keystroke daemon listening on http://127.0.0.1:${PORT}`);
  log(`  dryRun:   ${DRY_RUN}`);
  log(`  appGuard: ${APP_GUARD || '(none — fires blindly)'}`);
  log(`  tabGuard: ${TAB_GUARD || '(none)'}`);
  log(`grant Accessibility permission to your terminal app if the first FIRE fails silently.`);
});
