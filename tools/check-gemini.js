'use strict';
/**
 * Can Meeting Copilot reach Google Gemini (via Google AI Pro login or API key), and how fast?
 *
 *   node tools/check-gemini.js
 */
const store = require('../src/main/store');
const { GeminiEngine, geminiStatus } = require('../src/main/gemini');

function line() { console.log('  ' + '-'.repeat(66)); }

(async () => {
  console.log('');
  console.log('  Meeting Copilot - Google Gemini (Google AI Pro) connection check');
  line();
  const s = store.getSettings().brain;
  const st = geminiStatus(s.geminiPath, s.geminiKey);
  if (!st.installed) {
    console.log('  The Gemini CLI is not installed.');
    console.log('');
    process.exit(1);
  }
  console.log('  Gemini CLI :', st.exe || '(using direct API key)');
  console.log('  signed in  :', st.signedIn ? `yes (${st.detail})` : 'NO');
  line();
  if (!st.signedIn) {
    console.log('  Click "Sign in with Google Gemini" in the Dashboard and finish in your browser.');
    console.log('');
    process.exit(1);
  }

  const e = new GeminiEngine(s);
  e.setSystem('You help someone answer live in an interview or meeting. Reply in one short spoken sentence.');
  const t0 = Date.now();
  let ttft = 0;
  try {
    const text = await e.send(
      'THEY JUST SAID: Please introduce yourself and tell us about your current role.\nWrite what my person should say back.',
      () => { if (!ttft) ttft = Date.now() - t0; }
    );
    console.log(`  first chunk: ${ttft || (Date.now() - t0)} ms | complete: ${Date.now() - t0} ms`);
    console.log(`  answer     : "${text.slice(0, 90)}"`);
    line();
    console.log('  RESULT: Google Gemini is working.');
    console.log('');
  } catch (err) {
    console.log('  RESULT: cannot reach Google Gemini');
    console.log('  reason:', err.message);
    console.log('');
    process.exit(1);
  }
})();
