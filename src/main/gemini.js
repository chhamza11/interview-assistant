'use strict';
/**
 * Google AI Pro (Gemini) brain: connects through Google OAuth subscription login
 * (via Gemini CLI / Code Assist) or a direct Gemini API key.
 *
 * Why we store GEMINI_CLI_HOME inside data/gemini-home:
 *   - Keeps all Gemini CLI state and OAuth credentials inside the app's own
 *     writable folder (`data/gemini-home/.gemini/oauth_creds.json`), avoiding
 *     any permission conflicts with `~/.gemini`.
 *   - Performs the Google OAuth browser login directly in Node + Electron's
 *     `shell.openExternal(authUrl)`, so clicking "Sign in with Google Gemini"
 *     immediately opens your default browser with zero terminal popups!
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const APP_ROOT = path.join(__dirname, '..', '..');
const RUNTIME = path.join(APP_ROOT, '.runtime');
const GEMINI_HOME = path.join(APP_ROOT, 'data', 'gemini-home');

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Read the official installed-app OAuth client ID and secret directly from the
 * installed @google/gemini-cli bundle at runtime so no OAuth client strings are
 * ever hardcoded in git.
 */
function readGeminiCliOAuthClient(explicit) {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    };
  }
  const exe = findGemini(explicit);
  const roots = [
    path.join(RUNTIME, 'gemini', 'node_modules', '@google', 'gemini-cli', 'bundle'),
    ...(exe ? [path.join(path.dirname(exe), 'node_modules', '@google', 'gemini-cli', 'bundle')] : []),
  ];
  for (const dir of roots) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        const idMatch = txt.match(/OAUTH_CLIENT_ID\s*=\s*"([^"]+)"/);
        const secMatch = txt.match(/OAUTH_CLIENT_SECRET\s*=\s*"([^"]+)"/);
        if (idMatch && secMatch) {
          return { clientId: idMatch[1], clientSecret: secMatch[1] };
        }
      }
    } catch { /* try next */ }
  }
  return null;
}
const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const SIGN_IN_SUCCESS_URL = 'https://developers.google.com/gemini-code-assist/auth_success_gemini';
const SIGN_IN_FAILURE_URL = 'https://developers.google.com/gemini-code-assist/auth_failure_gemini';

function runtimeDirs() {
  return IS_WIN
    ? [path.join(RUNTIME, 'gemini'), path.join(RUNTIME, 'node')]
    : [path.join(RUNTIME, 'gemini', 'bin'), path.join(RUNTIME, 'node', 'bin')];
}

function geminiHomeDir() {
  return process.env.GEMINI_CLI_HOME || GEMINI_HOME;
}

function geminiDotDir() {
  return path.join(geminiHomeDir(), '.gemini');
}

function geminiEnv(exe, settings = {}) {
  const extra = [...(exe ? [path.dirname(exe)] : []), ...runtimeDirs()];
  if (!IS_WIN) extra.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  const env = {
    ...process.env,
    PATH: [...extra, process.env.PATH || ''].join(path.delimiter),
    GEMINI_CLI_HOME: geminiHomeDir(),
    GOOGLE_GENAI_USE_GCA: 'true',
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
    GEMINI_FORCE_FILE_STORAGE: 'true',
  };
  const key = (settings.geminiKey || '').trim();
  if (key) {
    env.GEMINI_API_KEY = key;
    delete env.GOOGLE_GENAI_USE_GCA;
  }
  return env;
}

function findGemini(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = os.homedir();
  const names = IS_WIN ? ['gemini.cmd', 'gemini.exe', 'gemini'] : ['gemini'];
  const dirs = [runtimeDirs()[0], ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  } else {
    dirs.push(
      path.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.volta', 'bin')
    );
  }
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function needsShell(exe) {
  return IS_WIN && /\.(cmd|bat)$/i.test(exe);
}

function quoteWin(a) {
  return /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a;
}

/**
 * Ensure `.gemini/settings.json` has `security.auth.selectedType = "oauth-personal"`
 * so non-interactive `gemini -p` calls know to use the Google account sign-in.
 */
function ensureGeminiOauthSetting() {
  try {
    const dir = geminiDotDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    let obj = {};
    if (fs.existsSync(file)) {
      try { obj = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { obj = {}; }
    }
    if (!obj.security) obj.security = {};
    if (!obj.security.auth) obj.security.auth = {};
    if (!obj.security.auth.selectedType) {
      obj.security.auth.selectedType = 'oauth-personal';
      fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    }
  } catch {
    /* ignore */
  }
}

/**
 * Check both our isolated `data/gemini-home/.gemini` and `~/.gemini` for existing
 * Google OAuth credentials, migrating from `~/.gemini` if the user already logged in there.
 */
function geminiStatus(explicit, geminiKey = '') {
  if (process.env.FAKE_GEMINI_STATE) {
    const exe = findGemini(explicit) || explicit || 'gemini';
    return {
      installed: true,
      signedIn: process.env.FAKE_GEMINI_STATE === 'in',
      exe,
      detail: process.env.FAKE_GEMINI_STATE === 'in' ? 'Signed in (test)' : 'Not signed in',
    };
  }
  const key = String(geminiKey || process.env.GEMINI_API_KEY || '').trim();
  const exe = findGemini(explicit);
  if (key) {
    return {
      installed: true,
      signedIn: true,
      exe,
      via: 'api-key',
      detail: 'Gemini API key configured.',
    };
  }
  if (!exe) {
    return { installed: false, signedIn: false, exe: null, detail: 'Gemini CLI not installed.' };
  }

  const dirsToCheck = [geminiDotDir(), path.join(os.homedir(), '.gemini')];
  let email = null;
  let hasTokens = false;

  for (const dir of dirsToCheck) {
    const oauthFile = path.join(dir, 'oauth_creds.json');
    const encFile = path.join(dir, 'gemini-credentials.json');
    const accountsFile = path.join(dir, 'google_accounts.json');

    try {
      if (!email && fs.existsSync(accountsFile)) {
        const acc = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        if (acc && typeof acc.active === 'string' && acc.active.trim()) {
          email = acc.active.trim();
        }
      }
    } catch { /* ignore */ }

    try {
      if (fs.existsSync(oauthFile)) {
        const creds = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
        if (creds && (creds.refresh_token || creds.access_token)) {
          hasTokens = true;
          // Ensure a copy is in geminiDotDir() too
          if (dir !== geminiDotDir()) {
            try {
              fs.mkdirSync(geminiDotDir(), { recursive: true });
              fs.writeFileSync(path.join(geminiDotDir(), 'oauth_creds.json'), JSON.stringify(creds, null, 2), 'utf8');
            } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }

    if (!hasTokens) {
      try {
        if (fs.existsSync(encFile) && fs.statSync(encFile).size > 20) {
          hasTokens = true;
        }
      } catch { /* ignore */ }
    }
  }

  const signedIn = Boolean(hasTokens);
  return {
    installed: true,
    signedIn,
    exe,
    email,
    detail: signedIn
      ? `Signed in with Google${email ? ` (${email})` : ''}`
      : 'Gemini CLI installed, not signed in yet',
  };
}

let activeAuthServer = null;

/**
 * Direct browser OAuth login for Google AI Pro / Gemini CLI.
 * Starts a loopback callback server on 127.0.0.1, opens the Google Sign-In URL
 * in the user's default browser (no terminal window flashing or closing!),
 * exchanges the authorization code for tokens, and writes `oauth_creds.json`
 * and `google_accounts.json` into `data/gemini-home/.gemini/`.
 */
function startGoogleOAuthSignIn(openUrlFn) {
  return new Promise((resolve) => {
    try {
      if (activeAuthServer) {
        try { activeAuthServer.close(); } catch { /* ignore */ }
        activeAuthServer = null;
      }

      ensureGeminiOauthSetting();

      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => {
          launchCallbackServer(port, openUrlFn, resolve);
        });
      });
      server.on('error', (e) => {
        resolve({ ok: false, error: 'Could not open local callback port: ' + e.message });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

function launchCallbackServer(port, openUrlFn, resolve) {
  const oauthClient = readGeminiCliOAuthClient();
  if (!oauthClient) {
    return resolve({ ok: false, error: 'Could not read OAuth client from installed @google/gemini-cli.' });
  }
  const { clientId: OAUTH_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET } = oauthClient;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const state = crypto.randomBytes(32).toString('hex');
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPE.join(' '),
    state,
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  const httpServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (!u.pathname.includes('/oauth2callback')) {
        res.writeHead(301, { Location: SIGN_IN_FAILURE_URL });
        res.end();
        return;
      }
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      if (!code || gotState !== state) {
        res.writeHead(301, { Location: SIGN_IN_FAILURE_URL });
        res.end();
        return;
      }

      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: OAUTH_CLIENT_ID,
          client_secret: OAUTH_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        res.writeHead(301, { Location: SIGN_IN_FAILURE_URL });
        res.end();
        return;
      }

      const rawTokens = await tokenRes.json();
      const creds = {
        access_token: rawTokens.access_token,
        refresh_token: rawTokens.refresh_token,
        scope: rawTokens.scope,
        token_type: rawTokens.token_type || 'Bearer',
        id_token: rawTokens.id_token,
        expiry_date: rawTokens.expires_in ? Date.now() + Number(rawTokens.expires_in) * 1000 : undefined,
      };

      const dotDir = geminiDotDir();
      fs.mkdirSync(dotDir, { recursive: true });
      fs.writeFileSync(path.join(dotDir, 'oauth_creds.json'), JSON.stringify(creds, null, 2), 'utf8');
      ensureGeminiOauthSetting();

      // Fetch user email for display
      try {
        const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${creds.access_token}` },
        });
        if (infoRes.ok) {
          const info = await infoRes.json();
          if (info && info.email) {
            fs.writeFileSync(
              path.join(dotDir, 'google_accounts.json'),
              JSON.stringify({ active: info.email, old: [] }, null, 2),
              'utf8'
            );
          }
        }
      } catch { /* ignore */ }

      res.writeHead(301, { Location: SIGN_IN_SUCCESS_URL });
      res.end();
    } catch {
      try {
        res.writeHead(301, { Location: SIGN_IN_FAILURE_URL });
        res.end();
      } catch { /* ignore */ }
    } finally {
      setTimeout(() => {
        try { httpServer.close(); } catch { /* ignore */ }
        if (activeAuthServer === httpServer) activeAuthServer = null;
      }, 500);
    }
  });

  activeAuthServer = httpServer;
  httpServer.listen(port, '127.0.0.1', () => {
    try {
      if (typeof openUrlFn === 'function') {
        openUrlFn(authUrl);
      } else {
        const { shell } = require('electron');
        if (shell && shell.openExternal) shell.openExternal(authUrl);
      }
      resolve({ ok: true, authUrl });
    } catch (e) {
      resolve({ ok: false, error: 'Could not open browser: ' + e.message });
    }
  });

  // Auto-close after 5 minutes if unused
  setTimeout(() => {
    if (activeAuthServer === httpServer) {
      try { httpServer.close(); } catch { /* ignore */ }
      activeAuthServer = null;
    }
  }, 5 * 60 * 1000).unref();
}

function workDir() {
  const dir = path.join(APP_ROOT, 'data', 'gemini-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class GeminiEngine {
  constructor(settings = {}, log = () => {}) {
    this.settings = settings;
    this.exe = findGemini(settings.geminiPath);
    this.apiKey = (settings.geminiKey || process.env.GEMINI_API_KEY || '').trim();
    this.model = (settings.geminiModel || DEFAULT_GEMINI_MODEL).trim();
    this.log = log;
    this.system = '';
    this._child = null;
    this._abort = null;
  }

  get configured() {
    return Boolean(this.apiKey || this.exe);
  }

  setSystem(system) {
    this.system = system || '';
  }

  abort() {
    if (this._abort) {
      try { this._abort.abort(); } catch { /* ignore */ }
      this._abort = null;
    }
    const c = this._child;
    this._child = null;
    if (c && c.exitCode === null) {
      try {
        const { spawnSync } = require('child_process');
        if (IS_WIN) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
        else c.kill('SIGTERM');
      } catch { /* ignore */ }
    }
  }

  async send(userText, onDelta, opts = {}) {
    if (!this.configured) {
      throw new Error('Google Gemini is not installed or configured. Click "Sign in with Google Gemini" on the Dashboard.');
    }
    this.abort();

    if (this.apiKey) {
      return this._sendViaApi(userText, onDelta, opts);
    }
    return this._sendViaCli(userText, onDelta, opts);
  }

  async _sendViaApi(userText, onDelta, opts = {}) {
    const controller = new AbortController();
    this._abort = controller;
    const model = this.model || DEFAULT_GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

    const body = {
      ...(this.system ? { systemInstruction: { parts: [{ text: this.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: opts.temperature != null ? opts.temperature : 0.35,
        maxOutputTokens: opts.maxTokens || 500,
      },
    };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      this._abort = null;
      if (e.name === 'AbortError') return '';
      throw new Error('Could not reach Google Gemini API: ' + (e.message || e));
    }

    if (!res.ok) {
      this._abort = null;
      let detail = '';
      try { detail = (await res.text()).slice(0, 220); } catch { /* ignore */ }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new Error('Gemini API rejected the key (' + res.status + '). Check it in Settings.');
      }
      if (res.status === 429) {
        throw new Error('Gemini rate limit reached (429). ' + detail);
      }
      throw new Error('Gemini API request failed (' + res.status + '). ' + detail);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const parts = j?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
              if (p.text) {
                full += p.text;
                if (onDelta) onDelta(p.text, full);
              }
            }
          } catch {
            /* partial chunk */
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally {
      this._abort = null;
    }

    return full.trim();
  }

  _sendViaCli(userText, onDelta, opts = {}) {
    ensureGeminiOauthSetting();

    const prompt = [
      this.system,
      '',
      'IMPORTANT: Reply with plain spoken text only. Do NOT call any tools, do NOT read files, and do NOT run shell commands.',
      '',
      userText,
    ].join('\n');

    const args = [
      '--output-format', 'stream-json',
      '--approval-mode', 'plan',
      ...(this.model ? ['-m', this.model] : []),
      '-p', 'Reply directly with the spoken answer only, following the instructions provided on stdin.',
    ];

    return new Promise((resolve, reject) => {
      const shell = needsShell(this.exe);
      const child = spawn(
        shell ? quoteWin(this.exe) : this.exe,
        shell ? args.map(quoteWin) : args,
        {
          cwd: workDir(),
          windowsHide: true,
          shell,
          env: geminiEnv(this.exe, this.settings),
        }
      );
      this._child = child;

      let buf = '';
      let full = '';
      let failure = '';
      let stderr = '';

      const timer = setTimeout(() => {
        failure = failure || 'Google Gemini took longer than 60 seconds to answer.';
        this.abort();
      }, opts.timeoutMs || 60000);

      const handleLine = (line) => {
        if (!line) return;
        let e;
        try { e = JSON.parse(line); } catch { return; }
        if (e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string') {
          if (e.delta) {
            full += e.content;
            if (onDelta) onDelta(e.content, full);
          } else {
            full = e.content;
            if (onDelta) onDelta(e.content, full);
          }
        } else if (e.type === 'error') {
          failure = explainGemini(e.message || 'Gemini request failed');
        }
      };

      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl).trim());
          buf = buf.slice(nl + 1);
        }
      });

      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error('Could not start the Gemini CLI: ' + e.message));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (buf.trim()) handleLine(buf.trim());
        const aborted = this._child !== child;
        if (!aborted) this._child = null;
        const out = full.trim();
        if (out) return resolve(out);
        if (aborted && !failure) return resolve('');
        reject(new Error(
          failure ||
          explainGemini(stderr) ||
          `The Gemini CLI stopped without an answer (exit ${code}).`
        ));
      });

      child.stdin.on('error', () => { /* process exited early */ });
      child.stdin.end(prompt);
    });
  }
}

function explainGemini(msg) {
  const m = String(msg || '');
  if (/Manual authorization is required|Authentication consent|not logged in|oauth|unauthori[sz]ed|401|sign in|Please set an Auth method/i.test(m)) {
    return 'Google Gemini is not signed in yet. Click "Sign in with Google Gemini" on the Dashboard and finish signing in with your Google AI Pro account.';
  }
  if (/usage limit|rate limit|429|quota/i.test(m)) {
    return 'Google Gemini rate/usage limit reached for this model. Try switching the Gemini model to gemini-2.5-flash in Settings.';
  }
  const cleaned = m
    .split(/\r?\n/)
    .filter((l) => !/^\[(INFO|WARN|WARNING|DEBUG)\]/i.test(l.trim()) && !/deprecated/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || m.replace(/\s+/g, ' ').trim()).slice(0, 300);
}

module.exports = {
  GeminiEngine,
  findGemini,
  geminiStatus,
  geminiEnv,
  ensureGeminiOauthSetting,
  startGoogleOAuthSignIn,
  explainGemini,
  DEFAULT_GEMINI_MODEL,
};
