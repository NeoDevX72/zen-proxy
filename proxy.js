const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { exec, execSync, spawn } = require('child_process');

const ZEN_HOST = 'opencode.ai';
const ZEN_PATH = '/zen/v1/chat/completions';
const ZEN_MODELS = '/zen/v1/models';

let msgCounter = 0;
function genId(prefix) {
  return `${prefix}_${Date.now()}_${++msgCounter}`;
}

const MODEL = process.env.MODEL || 'deepseek-v4-flash-free';

const APP_DIR = path.dirname(process.pkg ? process.execPath : __dirname);
const KEY_FILE = path.join(APP_DIR, 'zen-key.txt');
const LOG_FILE = path.join(APP_DIR, 'zen-proxy.log');
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const CONFIG_FILE = path.join(APP_DIR, 'zen-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

const userConfig = loadConfig();
let PORT = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  if (process.env.PORT) return parseInt(process.env.PORT, 10);
  if (userConfig.port) return parseInt(userConfig.port, 10);
  return 8080;
})();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { broadcastLog(line); } catch {}
}

function loadApiKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (key) return key;
    }
  } catch {}
  return null;
}

function saveApiKey(key) {
  try {
    fs.writeFileSync(KEY_FILE, key.trim(), 'utf8');
    log(`API key saved to ${KEY_FILE}`);
    return true;
  } catch (e) {
    log(`Failed to save API key: ${e.message}`);
    return false;
  }
}

function autoSetupSettings(apiKey) {
  try {
    const settingsDir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    const settings = {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
        ANTHROPIC_MODEL: 'deepseek-v4-flash-free',
        ANTHROPIC_API_KEY: apiKey || '',
        ENABLE_TOOL_SEARCH: 'true',
      },
      model: 'deepseek-v4-flash',
      autoUpdatesChannel: 'latest',
      theme: 'dark',
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    log(`Settings written to ${SETTINGS_FILE}`);
    return true;
  } catch (e) {
    log(`Failed to write settings: ${e.message}`);
    return false;
  }
}

function promptApiKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('');
    console.log('  ===============================================');
    console.log('       ZEN PROXY - First Time Setup');
    console.log('  ===============================================');
    console.log('');
    console.log('  Enter your Zen API key:');
    console.log('  (e.g. sk-Jalsky7b0YKbpCBP3laYLL... )');
    console.log('');
    rl.question('  > ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function zenRequest(path, method, headers, body, stream) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const apiKey = loadApiKey() || headers['x-api-key'] || headers['authorization']?.replace('Bearer ', '') || '';
    const opts = {
      hostname: ZEN_HOST,
      port: 443,
      path,
      method,
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    if (stream) opts.headers.Accept = 'text/event-stream';

    const req = https.request(opts, (res) => {
      if (stream) {
        if (res.statusCode.toString().startsWith('2')) return resolve(res);
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            reject(new Error(parsed.error?.message || `Zen API error: ${res.statusCode}`));
          } catch {
            reject(new Error(`Zen API error (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!res.statusCode.toString().startsWith('2')) {
            return reject(new Error(parsed.error?.message || `Zen API error: ${res.statusCode}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Zen API error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function convertTools(anthropicTools) {
  if (!anthropicTools) return undefined;
  return anthropicTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

function convertMessages(msgs, system) {
  const result = [];
  if (system) result.push({ role: 'system', content: system });

  for (const msg of msgs) {
    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter(c => c.type === 'text').map(c => c.text);
        const toolResults = msg.content.filter(c => c.type === 'tool_result');
        for (const tr of toolResults) {
          const tc = Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('\n') : (tr.content || '');
          result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tc });
        }
        if (textParts.length > 0) result.push({ role: 'user', content: textParts.join('\n') });
        if (toolResults.length > 0 || textParts.length > 0) continue;
        result.push({ role: 'user', content: '' });
      } else {
        result.push({ role: 'user', content: msg.content || '' });
      }
    } else if (msg.role === 'assistant') {
      const oai = { role: 'assistant' };
      let text = '';
      const tcs = [];
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'text') text += b.text;
          else if (b.type === 'tool_use') tcs.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } });
        }
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }
      oai.content = tcs.length ? null : (text || null);
      if (tcs.length) oai.tool_calls = tcs;
      oai.reasoning_content = '';
      result.push(oai);
    }
  }
  return result;
}

function toAnthropicResponse(oaiResp, model) {
  const choice = oaiResp.choices?.[0];
  if (!choice) return null;
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      try {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') });
      } catch { content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: {} }); }
    }
  }
  const sr = choice.finish_reason === 'stop' ? 'end_turn'
    : choice.finish_reason === 'tool_calls' ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens' : null;
  return {
    id: genId('msg'), type: 'message', role: 'assistant', content,
    model, stop_reason: sr, stop_sequence: null,
    usage: { input_tokens: oaiResp.usage?.prompt_tokens || 0, output_tokens: oaiResp.usage?.completion_tokens || 0 },
  };
}

function toAnthropicError(status, message) {
  return {
    type: 'error',
    error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message },
  };
}

class StreamTranslator {
  constructor(model) {
    this.model = model;
    this.msgId = genId('msg');
    this.contentIdx = -1;
    this.toolAcc = {};
    this.hasMsgStart = false;
    this.openBlock = null;
  }

  push(chunk) {
    const events = [];
    const choice = chunk.choices?.[0];
    if (!choice) return events;
    const { delta = {}, finish_reason: fr } = choice;
    if (!this.hasMsgStart) {
      this.hasMsgStart = true;
      events.push({
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: { id: this.msgId, type: 'message', role: 'assistant', content: [], model: this.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        }),
      });
    }

    if (delta.content) {
      if (this.openBlock !== 'text') {
        if (this.openBlock) events.push({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: this.contentIdx }) });
        this.contentIdx++;
        this.openBlock = 'text';
        events.push({
          event: 'content_block_start',
          data: JSON.stringify({ type: 'content_block_start', index: this.contentIdx, content_block: { type: 'text', text: '' } }),
        });
      }
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({ type: 'content_block_delta', index: this.contentIdx, delta: { type: 'text_delta', text: delta.content } }),
      });
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (tc.function?.name || tc.id) {
          if (this.openBlock) events.push({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: this.contentIdx }) });
          this.contentIdx++;
          this.openBlock = 'tool';
          this.toolAcc[idx] = { id: tc.id || `call_${idx}`, name: tc.function?.name || '', args: '' };
          events.push({
            event: 'content_block_start',
            data: JSON.stringify({ type: 'content_block_start', index: this.contentIdx, content_block: { type: 'tool_use', id: this.toolAcc[idx].id, name: this.toolAcc[idx].name, input: {} } }),
          });
        }
        if (tc.function?.arguments) {
          this.toolAcc[idx].args += tc.function.arguments;
          events.push({
            event: 'content_block_delta',
            data: JSON.stringify({ type: 'content_block_delta', index: this.contentIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }),
          });
        }
      }
    }

    if (fr) {
      if (this.openBlock) events.push({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: this.contentIdx }) });
      this.openBlock = null;
      const sr = fr === 'stop' ? 'end_turn' : fr === 'tool_calls' ? 'tool_use' : fr === 'length' ? 'max_tokens' : null;
      events.push({
        event: 'message_delta',
        data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: sr, stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens || 0 } }),
      });
      events.push({ event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) });
    }

    return events;
  }
}

function writeSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

async function handleMessages(req, res) {
  let body;
  try { body = await parseBody(req); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(toAnthropicError(400, 'Invalid JSON')));
  }

  const model = MODEL;
  const system = body.system || '';
  const stream = body.stream === true;
  const maxTokens = body.max_tokens || 8192;

  log(`${req.method} /v1/messages | model=${model} stream=${stream} msgs=${body.messages?.length || 0}`);
  const convertedMsgs = convertMessages(body.messages || [], system);
  log(`  Converted: ${convertedMsgs.length} msgs, roles: [${convertedMsgs.map(m=>m.role).join(', ')}]`);

  const zenBody = {
    model,
    messages: convertedMsgs,
    max_tokens: maxTokens,
    stream,
  };
  if (body.tools) zenBody.tools = convertTools(body.tools);
  if (body.tool_choice) {
    log(`  tool_choice: ${JSON.stringify(body.tool_choice)} (stripped for DeepSeek)`);
  }
  if (body.stop_sequences) zenBody.stop = body.stop_sequences;
  if (body.temperature !== undefined) zenBody.temperature = body.temperature;
  if (body.top_p !== undefined) zenBody.top_p = body.top_p;

  try {
    if (stream) {
      const zenRes = await zenRequest(ZEN_PATH, 'POST', req.headers, zenBody, true);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      });

      const translator = new StreamTranslator(model);
      let buffer = '';

      zenRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const events = translator.push(parsed);
            for (const ev of events) writeSSE(res, ev.event, ev.data);
          } catch { }
        }
      });

      zenRes.on('end', () => {
        if (!translator.hasMsgStart) {
          writeSSE(res, 'message_start', JSON.stringify({
            type: 'message_start',
            message: { id: genId('msg'), type: 'message', role: 'assistant', content: [], model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          }));
          writeSSE(res, 'message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }));
          writeSSE(res, 'message_stop', JSON.stringify({ type: 'message_stop' }));
        }
        res.end();
      });

      zenRes.on('error', (err) => {
        log(`Stream error: ${err.message}`);
        res.end();
      });
    } else {
      const zenResp = await zenRequest(ZEN_PATH, 'POST', req.headers, zenBody, false);
      const anthResp = toAnthropicResponse(zenResp, model);
      log(`Response: ${anthResp?.content?.length || 0} blocks, stop_reason=${anthResp?.stop_reason}`);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      });
      res.end(JSON.stringify(anthResp));
    }
  } catch (err) {
    log(`Error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(toAnthropicError(502, err.message)));
  }
}

async function handleModels(req, res) {
  log(`GET /v1/models`);
  try {
    const data = await zenRequest(ZEN_MODELS, 'GET', {}, null, false);
    const models = (data.data || []).map(m => ({
      type: 'model',
      id: m.id || m.name || m.model,
      display_name: m.id || m.name || m.model,
      created: Math.floor(Date.now() / 1000),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: models }));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ type: 'model', id: MODEL, display_name: `DeepSeek V4 Flash Free (${MODEL})`, created: Math.floor(Date.now() / 1000) }],
    }));
  }
}

// ========== LOG SSE STREAM ==========
let logClients = [];
function broadcastLog(line) {
  const data = JSON.stringify({ text: line });
  logClients = logClients.filter(c => {
    try { c.write(`data: ${data}\n\n`); return true; } catch { return false; }
  });
}

function closeAllSSE() {
  logClients.forEach(c => { try { c.destroy(); } catch {} });
  logClients = [];
}

function handleLogSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ text: 'Connected to log stream' })}\n\n`);
  logClients.push(res);
  req.on('close', () => {
    logClients = logClients.filter(c => c !== res);
  });
}

function maskKey(key) {
  if (!key) return 'Not set';
  if (key.length > 12) return `${key.slice(0, 8)}...${key.slice(-4)}`;
  return 'Saved';
}

// ========== DASHBOARD HTML ==========
function serveDashboard(req, res) {
  const apiKey = loadApiKey();
  const masked = maskKey(apiKey);
  const settingsExists = fs.existsSync(SETTINGS_FILE) ? 'Configured' : 'Not configured';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZenProxy Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
   body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         background: #0f0f1a; color: #e2e8f0; height: 100vh; overflow: hidden; display: flex; }
   .sidebar { width: 240px; background: #1a1a2e; padding: 24px 16px; display: flex;
             flex-direction: column; border-right: 1px solid #2d2d44; flex-shrink: 0; height: 100vh; overflow-y: auto; }
  .logo { font-size: 20px; font-weight: 700; margin-bottom: 4px; color: #e2e8f0; }
  .tagline { font-size: 12px; color: #94a3b8; margin-bottom: 24px; }
  .status-badge { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                  background: #2d2d44; border-radius: 6px; margin-bottom: 20px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
  .dot.stopped { background: #94a3b8; }
  .stat { margin-bottom: 16px; }
  .stat-label { font-size: 11px; text-transform: uppercase; color: #64748b; margin-bottom: 2px; letter-spacing: 0.5px; }
  .stat-value { font-size: 13px; color: #e2e8f0; word-break: break-all; }
  .nav-btn { display: block; width: 100%; padding: 8px 12px; margin-bottom: 6px;
             background: #2d2d44; border: none; color: #e2e8f0; border-radius: 6px;
             cursor: pointer; font-size: 13px; text-align: left; transition: background 0.15s; }
  .nav-btn:hover { background: #3b3b5c; }
  .nav-btn.danger { color: #ef4444; }
  .nav-btn.danger:hover { background: #3b1a1a; }
   .main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100vh; }
  .toolbar { padding: 12px 20px; background: #1a1a2e; border-bottom: 1px solid #2d2d44;
             display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .toolbar-title { font-size: 13px; font-weight: 600; color: #94a3b8; }
  .toolbar-actions { margin-left: auto; display: flex; gap: 8px; }
  .tb-btn { padding: 6px 14px; border: 1px solid #2d2d44; background: transparent; color: #94a3b8;
            border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
  .tb-btn:hover { background: #2d2d44; color: #e2e8f0; }
  .tb-btn.active { background: #22c55e; color: #000; border-color: #22c55e; }
  .log-container { flex: 1; padding: 12px 20px; overflow-y: auto; font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
                   font-size: 12px; line-height: 1.6; background: #0a0a14; }
  .log-line { white-space: pre-wrap; word-break: break-all; }
  .log-line:hover { background: rgba(255,255,255,0.03); }
  .log-line.info { color: #e2e8f0; }
  .log-line.warn { color: #fbbf24; }
  .log-line.error { color: #ef4444; }
  .empty-logs { color: #64748b; text-align: center; padding: 40px; font-family: 'Segoe UI', sans-serif; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2d2d44; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #3b3b5c; }
  .port-input { display: flex; gap: 4px; align-items: center; }
  .port-input input { flex: 1; background: #1a1a2e; border: 1px solid #3b3b5c; color: #e2e8f0;
    padding: 4px 8px; border-radius: 4px; font-size: 12px; font-family: 'Consolas', monospace; outline: none; }
  .port-input input:focus { border-color: #7c3aed; }
  .port-input button { background: #7c3aed; border: none; color: #fff; padding: 4px 10px;
    border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap; }
  .port-input button:hover { background: #6d28d9; }
  .port-input .saved { color: #22c55e; font-size: 11px; }
  @media (max-width: 700px) { .sidebar { width: 200px; } }
</style>
</head>
<body>
<div class="sidebar">
  <div class="logo">ZenProxy</div>
  <div class="tagline">DeepSeek V4 Flash Free → Claude Code</div>
  <div class="status-badge">
    <div class="dot" id="statusDot"></div>
    <span id="statusText">Running</span>
  </div>
  <div class="stat">
    <div class="stat-label">Port</div>
    <div class="port-input">
      <input type="number" id="portInput" value="${PORT}" min="1" max="65535">
      <button onclick="savePort()">Apply</button>
      <span id="portStatus" style="display:none;color:#22c55e;font-size:11px">Saved</span>
    </div>
  </div>
  <div class="stat">
    <div class="stat-label">Model</div>
    <div class="stat-value">${MODEL}</div>
  </div>
  <div class="stat">
    <div class="stat-label">API Key</div>
    <div class="stat-value">${masked}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Settings</div>
    <div class="stat-value">${settingsExists}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Log File</div>
    <div class="stat-value" style="font-size:11px;word-break:break-all">${LOG_FILE}</div>
  </div>
  <div style="margin-top:auto">
    <button class="nav-btn" onclick="if(confirm('Restart proxy?')){this.disabled=true;window.location.href='/api/restart'}">Restart Proxy</button>
    <button class="nav-btn danger" onclick="if(confirm('Shutdown proxy?')){this.disabled=true;window.location.href='/api/shutdown'}">Shutdown</button>
  </div>
</div>
<div class="main">
  <div class="toolbar">
    <span class="toolbar-title">CONSOLE LOGS</span>
    <div class="toolbar-actions">
      <button class="tb-btn" onclick="document.getElementById('logContainer').innerHTML=''">Clear</button>
      <button class="tb-btn" onclick="window.open('/log-file','_blank')">Open File</button>
    </div>
  </div>
  <div class="log-container" id="logContainer">
    <div class="empty-logs">Connecting to log stream...</div>
  </div>
</div>
<script>
  const container = document.getElementById('logContainer');
  const es = new EventSource('/logs');
  let autoScroll = true;
  container.addEventListener('scroll', () => {
    autoScroll = container.scrollTop + container.clientHeight >= container.scrollHeight - 20;
  });
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      const empty = container.querySelector('.empty-logs');
      if (empty) empty.remove();
      const line = document.createElement('div');
      line.className = 'log-line info';
      let text = d.text || '';
      if (text.includes('Error') || text.includes('error') || text.includes('fail')) line.className = 'log-line error';
      else if (text.includes('warn')) line.className = 'log-line warn';
      line.textContent = text;
      container.appendChild(line);
      if (autoScroll) line.scrollIntoView({ behavior: 'smooth' });
    } catch(e) {}
  };
  es.onerror = () => {
    const empty = container.querySelector('.empty-logs');
    if (!empty) {
      const d = document.createElement('div');
      d.className = 'empty-logs';
      d.textContent = 'Proxy stopped';
      document.getElementById('statusDot').className = 'dot stopped';
      document.getElementById('statusText').textContent = 'Stopped';
      container.appendChild(d);
      setTimeout(() => { try { window.close(); } catch {} }, 2000);
    }
  };
  setInterval(async () => {
    try {
      const r = await fetch('/api/status');
      const d = await r.json();
      if (!d.running) {
        document.getElementById('statusDot').className = 'dot stopped';
        document.getElementById('statusText').textContent = 'Stopped';
      }
    } catch {}
  }, 2000);

  async function savePort() {
    const input = document.getElementById('portInput');
    const status = document.getElementById('portStatus');
    const btn = input.nextElementSibling;
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: parseInt(input.value) })
      });
      const d = await r.json();
      if (d.saved) {
        status.style.display = 'inline'; status.textContent = 'Restarting...';
        btn.textContent = 'Applied';
        setTimeout(() => {
          const newUrl = 'http://127.0.0.1:' + d.port + '/';
          let tries = 0;
          function tryConnect() {
            fetch(newUrl).then(r => { if (r.ok) { window.location.href = newUrl; setTimeout(() => { try { window.close(); } catch {} }, 500); } else retry(); }).catch(retry);
          }
          function retry() {
            tries++;
            if (tries < 20) setTimeout(tryConnect, 2000);
            else { status.textContent = 'Timeout - restart manually'; status.style.color = '#ef4444'; btn.disabled = false; btn.textContent = 'Apply'; }
          }
          tryConnect();
        }, 3000);
      } else {
        btn.textContent = 'Apply';
        btn.disabled = false;
        status.style.display = 'inline'; status.textContent = d.error || 'Error'; status.style.color = '#ef4444';
      }
    } catch(e) {
      btn.textContent = 'Apply'; btn.disabled = false;
      status.style.display = 'inline'; status.textContent = 'Failed'; status.style.color = '#ef4444';
    }
  }
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// ========== API ENDPOINTS ==========
let shuttingDown = false;

function restartProcess(targetPort) {
  closeAllSSE();
  const config = loadConfig();
  const newPort = targetPort || config.port || PORT;
  // Stop accepting new connections, then force-close remaining after response is sent
  try { server.close(); } catch {}
  try { server.closeIdleConnections(); } catch {}
  setImmediate(() => {
    try { server.closeAllConnections(); } catch {}
    PORT = newPort;
    const newServer = http.createServer(handleRequest);
    newServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        log(`Port ${PORT} in use, trying ${PORT + 1}`);
        PORT++;
        newServer.listen(PORT, '127.0.0.1');
        return;
      }
    });
    newServer.listen(PORT, '127.0.0.1', () => {
      log(`Server restarted on http://127.0.0.1:${PORT}`);
      broadcastLog(`Server restarted on port ${PORT}`);
    });
    server = newServer;
  });
  return newPort;
}

function handleRestart(req, res) {
  log('Restart requested via dashboard');
  const port = restartProcess(PORT);
  serveStopPage(res, 'restart', port);
  broadcastLog('--- RESTARTING ---');
}

function handleConfig(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ port: PORT }));
  }
  parseBody(req).then(data => {
    if (!data.port) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No port provided' }));
    }
    const newPort = parseInt(data.port, 10);
    if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid port (1-65535)' }));
    }
    const config = loadConfig();
    config.port = newPort;
    saveConfig(config);
    log(`Port changed to ${newPort} via dashboard`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ saved: true, port: newPort }));
    restartProcess(newPort);
  }).catch(() => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  });
}

function serveStopPage(res, type, port) {
  const isRestart = type === 'restart';
  const redirectPort = port || PORT;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  const refreshMeta = isRestart ? '<meta http-equiv="refresh" content="2;url=http://127.0.0.1:' + redirectPort + '/">' : '';
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${refreshMeta}<title>ZenProxy</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1a2e;padding:40px 48px;border-radius:12px;text-align:center;border:1px solid #2d2d44}
.dot{width:12px;height:12px;border-radius:50%;margin:0 auto 16px}
.dot.yellow{background:#fbbf24}.dot.red{background:#ef4444}
h2{color:#e2e8f0;margin:0 0 8px;font-size:20px}
p{color:#94a3b8;font-size:14px}
</style></head><body><div class="card"><div class="dot ${isRestart ? 'yellow' : 'red'}"></div><h2>${isRestart ? 'Restarting...' : 'Shut Down'}</h2><p>${isRestart ? 'Proxy is restarting. This page will reload.' : 'ZenProxy has stopped. You may close this tab.'}</p></div></body></html>`);
}

function handleShutdown(req, res) {
  log('Shutdown requested via dashboard');
  broadcastLog('--- SHUTDOWN ---');
  closeAllSSE();
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ZenProxy</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1a2e;padding:40px 48px;border-radius:12px;text-align:center;border:1px solid #2d2d44}
.dot{width:12px;height:12px;border-radius:50%;margin:0 auto 16px;background:#ef4444}
h2{color:#e2e8f0;margin:0 0 8px;font-size:20px}
p{color:#94a3b8;font-size:14px;margin:0 0 8px}
small{color:#64748b;font-size:11px;display:block;margin-top:12px}</style></head><body><div class="card"><div class="dot"></div><h2>Shut Down</h2><p>ZenProxy has stopped. Close this tab.</p><small>You may close the console window manually.</small></div></body></html>`);
  res.once('finish', () => {
    const cp = require('child_process');
    // Spawn detached taskkill to kill this process from outside
    cp.spawn('taskkill', ['/f', '/pid', String(process.pid)], {
      detached: true, windowsHide: true, stdio: 'ignore'
    }).unref();
    // Fallback: try process.exit after a delay
    setTimeout(() => {
      try { process.exit(0); } catch {}
    }, 2000);
  });
}

function handleStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ running: !shuttingDown }));
}

function handleLogFile(req, res) {
  if (fs.existsSync(LOG_FILE)) {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(content);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('No log file yet.');
  }
}

function handleRequest(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const path = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key, anthropic-version, authorization');

  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (path === '/' && req.method === 'GET') return serveDashboard(req, res);
  if (path === '/logs' && req.method === 'GET') return handleLogSSE(req, res);
  if (path === '/log-file' && req.method === 'GET') return handleLogFile(req, res);
  if (path === '/api/status' && req.method === 'GET') return handleStatus(req, res);
  if (path === '/api/config' && (req.method === 'GET' || req.method === 'POST')) return handleConfig(req, res);
  if (path === '/api/restart' && (req.method === 'GET' || req.method === 'POST')) return handleRestart(req, res);
  if (path === '/api/shutdown' && (req.method === 'GET' || req.method === 'POST')) return handleShutdown(req, res);
  if (path === '/v1/messages' && req.method === 'POST') return handleMessages(req, res);
  if (path === '/v1/models' && req.method === 'GET') return handleModels(req, res);

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

let server = http.createServer(handleRequest);

process.on('SIGINT', () => {
  log('Shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  log('Shutting down...');
  server.close(() => process.exit(0));
});

async function main() {
  console.log('');
  console.log('  ==============================================');
  console.log('       ZEN PROXY v1.0');
  console.log('       DeepSeek V4 Flash Free -> Claude Code');
  console.log('  ==============================================');
  console.log('');

  let apiKey = loadApiKey();
  if (!apiKey) {
    apiKey = await promptApiKey();
    if (!apiKey) {
      console.log('  No API key entered. Exiting.');
      process.exit(1);
    }
    saveApiKey(apiKey);
  } else {
    const masked = apiKey.slice(0, 8) + '...' + apiKey.slice(-4);
    console.log(`  API key: ${masked}`);
  }

  if (autoSetupSettings(apiKey)) {
    console.log(`  Settings: ${SETTINGS_FILE}`);
  }

  server.listen(PORT, '127.0.0.1', () => {
    log(`Running on http://127.0.0.1:${PORT}`);
    log(`Model: ${MODEL}`);
    log(`Forwarding to: https://${ZEN_HOST}${ZEN_PATH}`);
    log(`Log file: ${LOG_FILE}`);
    const url = `http://127.0.0.1:${PORT}`;
    if (!process.argv.includes('--no-browser') && !process.argv.includes('--headless')) {
      setTimeout(() => {
        log(`Opening dashboard...`);
        try {
          exec(`start msedge --app="${url}" --no-first-run 2>nul || start chrome --app="${url}" --no-first-run 2>nul || start "${url}"`);
        } catch {}
      }, 1500);
    }
  });
}

main();
