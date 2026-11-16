'use strict';
/**
 * Which AI can write the answers on this computer, and signing in to it.
 *
 * Three subscriptions can drive the app:
 *   Claude   the Claude Code CLI      claude auth status --json / claude auth login
 *   ChatGPT  the Codex CLI            codex login status        / codex login
 *   Gemini   Google AI Pro / Gemini   direct browser OAuth -> data/gemini-home/.gemini/oauth_creds.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { findCodex, codexEnv } = require('./codex');
const { findGemini, geminiStatus, startGoogleOAuthSignIn } = require('./gemini');

const IS_WIN = process.platform === 'win32';

/** Where the Claude CLI lands for each way of installing it. */
function findClaude(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = os.homedir();
  const names = IS_WIN ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = [
    path.join(home, '.local', 'bin'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ];
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'));
  }
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

function cliEnv(exe) {
  const env = codexEnv(exe);
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_/.test(k) || k === 'CLAUDECODE') delete env[k];
  }
  return env;
}

function run(exe, args, timeout = 15000) {
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(exe);
  const r = spawnSync(shell ? `"${exe}"` : exe, args,
    { encoding: 'utf8', timeout, windowsHide: true, shell, env: cliEnv(exe) });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function claudeStatus(claudePath) {
  const exe = findClaude(claudePath);
  if (!exe) return { installed: false, signedIn: false };
  const r = run(exe, ['auth', 'status', '--json']);
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    return { installed: true, signedIn: !!j.loggedIn, exe };
  } catch {
    return { installed: true, signedIn: null, exe, old: true };
  }
}

function chatgptStatus(codexPath) {
  const exe = findCodex(codexPath);
  if (!exe) return { installed: false, signedIn: false };
  const r = run(exe, ['login', 'status']);
  return { installed: true, signedIn: r.status === 0 && /logged in/i.test(r.out), exe };
}

/** All providers, plus which one the app should use. */
function detect(settings = {}) {
  const claude = claudeStatus(settings.claudePath);
  const chatgpt = chatgptStatus(settings.codexPath);
  const gemini = geminiStatus(settings.geminiPath, settings.geminiKey);
  const chosen = (settings.provider || 'claude').toLowerCase();
  let use = chosen;

  if (chosen === 'claude' && claude.signedIn === false) {
    if (gemini.signedIn) use = 'gemini';
    else if (chatgpt.signedIn) use = 'codex';
  }
  if (chosen === 'claude' && !claude.installed) {
    if (gemini.installed) use = 'gemini';
    else if (chatgpt.installed) use = 'codex';
  }
  if (chosen === 'codex' && !chatgpt.signedIn) {
    if (claude.signedIn) use = 'claude';
    else if (gemini.signedIn) use = 'gemini';
  }
  if (chosen === 'gemini' && !gemini.signedIn) {
    if (claude.signedIn) use = 'claude';
    else if (chatgpt.signedIn) use = 'codex';
  }

  const ready = chosen === 'openai' ? !!settings.openaiKey
    : use === 'gemini' ? !!gemini.signedIn
    : use === 'codex' ? !!chatgpt.signedIn
    : claude.signedIn !== false;
  return { claude, chatgpt, gemini, use, ready };
}

/**
 * Start a sign-in. Opens the browser directly and watches detect() for completion.
 */
async function signIn(which, settings = {}) {
  if (which === 'gemini') {
    const exe = findGemini(settings.geminiPath);
    if (!exe) {
      return {
        ok: false,
        error: 'Google Gemini needs the Gemini CLI (@google/gemini-cli).',
      };
    }
    return startGoogleOAuthSignIn();
  }

  const exe = which === 'chatgpt' ? findCodex(settings.codexPath) : findClaude(settings.claudePath);
  if (!exe) {
    return { ok: false, error: which === 'chatgpt'
      ? 'ChatGPT needs the Codex CLI. Run the install line again with ChatGPT chosen (see the README).'
      : 'Claude needs the Claude CLI. Run the installer again, or see claude.com/claude-code' };
  }
  const args = which === 'chatgpt' ? ['login'] : ['auth', 'login', '--claudeai'];
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(exe);
  try {
    const child = spawn(shell ? `"${exe}"` : exe, args,
      { detached: true, stdio: 'ignore', windowsHide: true, shell, env: cliEnv(exe) });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { detect, signIn, findClaude, claudeStatus, chatgptStatus, geminiStatus };
