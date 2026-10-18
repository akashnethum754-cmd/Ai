// Run: npm i && ADMIN_PASSWORD=yourpass node server.js   (Node 18+)
const express = require('express'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const PORT = process.env.PORT || 3000, ADMIN = process.env.ADMIN_PASSWORD || 'admin123', DBF = path.join(__dirname, 'db.json');
let db = { gemini: [], keys: [] };
try { db = JSON.parse(fs.readFileSync(DBF)); } catch {}
let st; const save = () => { clearTimeout(st); st = setTimeout(() => fs.writeFile(DBF, JSON.stringify(db), () => {}), 300); };
const rid = n => crypto.randomBytes(n).toString('hex');
const logs = [], sessions = new Map(), hits = new Map(); let rr = 0;

const app = express();
app.disable('x-powered-by');
app.use((q, s, n) => { s.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); q.method === 'OPTIONS' ? s.end() : n(); });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ---------- ADMIN ----------
const auth = (q, s, n) => q.headers['x-admin'] === ADMIN ? n() : s.status(401).json({ error: 'unauthorized' });
const mask = k => k.slice(0, 6) + '••••' + k.slice(-4);
app.get('/admin/data', auth, (q, s) => s.json({ gemini: db.gemini.map(g => ({ ...g, key: mask(g.key) })), keys: db.keys }));
app.post('/admin/gemini', auth, (q, s) => {
  const { label, key } = q.body; if (!key) return s.status(400).json({ error: 'key required' });
  db.gemini.push({ id: rid(4), label: label || 'Key ' + (db.gemini.length + 1), key: key.trim(), off: false }); save(); s.json({ ok: 1 });
});
app.delete('/admin/gemini/:id', auth, (q, s) => { db.gemini = db.gemini.filter(g => g.id !== q.params.id); db.keys.forEach(k => k.pool = k.pool.filter(i => i !== q.params.id)); save(); s.json({ ok: 1 }); });
app.post('/admin/keys', auth, (q, s) => {
  const b = q.body; if (!b.name) return s.status(400).json({ error: 'name required' });
  const k = { id: rid(4), key: 'sk-' + rid(24), name: b.name.trim(), model: b.model || 'gemini-2.5-flash', system: b.system || '',
    temp: +b.temp || 0.7, maxTokens: +b.maxTokens || 1024, rpm: +b.rpm || 60, pool: b.pool || [], active: true, created: Date.now() };
  db.keys.push(k); save(); s.json(k);
});
app.patch('/admin/keys/:id', auth, (q, s) => {
  const k = db.keys.find(x => x.id === q.params.id); if (!k) return s.status(404).json({ error: 'not found' });
  for (const f of ['name', 'model', 'system', 'temp', 'maxTokens', 'rpm', 'pool', 'active']) if (f in q.body) k[f] = q.body[f];
  save(); s.json(k);
});
app.delete('/admin/keys/:id', auth, (q, s) => { db.keys = db.keys.filter(k => k.id !== q.params.id); save(); s.json({ ok: 1 }); });
app.get('/admin/stats', auth, (q, s) => {
  const now = Date.now(), hours = Array.from({ length: 24 }, () => ({ ok: 0, err: 0 })), per = {};
  let sum = 0, n = 0, errs = 0;
  for (const l of logs) {
    const h = 23 - Math.floor((now - l.t) / 3.6e6); if (h >= 0) hours[h][l.ok ? 'ok' : 'err']++;
    const p = per[l.key] ||= { req: 0, err: 0, ms: 0 }; p.req++; p.ms += l.ms; if (!l.ok) { p.err++; errs++; } sum += l.ms; n++;
  }
  s.json({ hours, per, total: n, errors: errs, avg: n ? Math.round(sum / n) : 0, recent: logs.slice(-60).reverse() });
});

// ---------- PUBLIC API ----------
const hide = (t, name) => String(t || '').replace(/gemini|bard/gi, name).replace(/generativelanguage\.googleapis\.com/g, 'upstream');
const toErr = (st) => st === 429 ? ['rate_limit', 'Server busy, please retry shortly.'] : st === 401 || st === 403 ? ['provider_auth', 'Provider key rejected or out of quota.'] :
  st === 400 ? ['bad_request', 'Invalid request.'] : ['upstream_error', 'Temporary upstream error.'];

async function chat(q, s) {
  const t0 = Date.now(), tok = (q.headers.authorization || '').replace(/^Bearer\s+/i, '') || q.headers['x-api-key'];
  const k = db.keys.find(x => x.key === tok);
  const fail = (code, type, msg, raw) => {
    logs.push({ t: Date.now(), key: k ? k.name : 'unknown', ok: false, status: code, ms: Date.now() - t0, err: raw || msg });
    if (logs.length > 1000) logs.shift();
    s.status(code).json({ error: { message: msg, type, model: k && k.name } });
  };
  if (!k) return fail(401, 'invalid_api_key', 'Invalid API key.');
  if (!k.active) return fail(403, 'key_disabled', 'This API key is disabled.');
  const w = Math.floor(Date.now() / 60000) + k.id, c = (hits.get(w) || 0) + 1; hits.set(w, c); if (hits.size > 500) hits.delete(hits.keys().next().value);
  if (c > k.rpm) return fail(429, 'rate_limit', `Rate limit ${k.rpm}/min exceeded.`);

  // build conversation
  const b = q.body || {}; let sys = k.system, contents = [], sk;
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      const text = typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('');
      if (m.role === 'system') sys += '\n' + text; else contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
    }
  } else if (b.message) {
    sk = k.id + ':' + (b.session || b.user || 'default');
    contents = [...(sessions.get(sk) || []), { role: 'user', parts: [{ text: String(b.message) }] }];
  }
  if (!contents.length) return fail(400, 'bad_request', 'Send "message" or "messages".');
  sys = `Your name is "${k.name}". You are an independent AI assistant called ${k.name}. Never mention or hint at Google, Gemini, Bard or any underlying model or provider; if asked who made you, say you are ${k.name}.\n` + sys;

  const body = { systemInstruction: { parts: [{ text: sys }] }, contents,
    generationConfig: { temperature: +b.temperature || k.temp, maxOutputTokens: +b.max_tokens || k.maxTokens } };
  if (/2\.5-(flash|flash-lite)$/.test(k.model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 }; // speed

  const pool = db.gemini.filter(g => !g.off && (!k.pool.length || k.pool.includes(g.id)));
  if (!pool.length) return fail(503, 'no_provider', 'No provider key configured.');
  const start = rr++; let last = { st: 500, raw: '' };
  for (let i = 0; i < Math.min(pool.length, 3); i++) {
    const g = pool[(start + i) % pool.length];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${k.model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': g.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (!r.ok) { last = { st: r.status, raw: `[${g.label}] ${j.error && j.error.message || r.status}` }; if (r.status === 400) break; continue; }
      const cand = j.candidates && j.candidates[0], text = hide(cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || '').join(''), k.name);
      if (!text) return fail(502, 'empty_response', 'Response was blocked or empty.', 'finish: ' + (cand && cand.finishReason || j.promptFeedback && j.promptFeedback.blockReason));
      if (sk) { const h = [...contents, { role: 'model', parts: [{ text }] }].slice(-20); sessions.set(sk, h); if (sessions.size > 5000) sessions.delete(sessions.keys().next().value); }
      const u = j.usageMetadata || {}, ms = Date.now() - t0;
      logs.push({ t: Date.now(), key: k.name, ok: true, status: 200, ms }); if (logs.length > 1000) logs.shift();
      return s.json({ id: 'chatcmpl-' + rid(8), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: k.name, reply: text,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: u.promptTokenCount || 0, completion_tokens: u.candidatesTokenCount || 0, total_tokens: u.totalTokenCount || 0 }, latency_ms: ms });
    } catch (e) { last = { st: 504, raw: e.name + ': ' + e.message }; }
  }
  const [type, msg] = toErr(last.st); fail(last.st >= 400 && last.st < 600 ? last.st : 502, type, msg, last.raw);
}
app.post('/v1/chat/completions', chat);
app.post('/v1/chat', chat);
app.get('/v1/models', (q, s) => { const k = db.keys.find(x => x.key === (q.headers.authorization || '').replace(/^Bearer\s+/i, '')); s.json({ data: k ? [{ id: k.name, object: 'model' }] : [] }); });
app.get('/health', (q, s) => s.json({ ok: true }));
app.listen(PORT, () => console.log('Platform running on :' + PORT));
