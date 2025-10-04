import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { getDb, initDb } from './db.js';
import { downloadAipptTemplate } from './services/aipptDownloader.js';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = getDb();
await initDb();

// Runtime options
const defaultHeadless = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/static', express.static(path.join(__dirname, 'public')));

// Basic auth for admin
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }
  const base64 = authHeader.split(' ')[1];
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');
  if (user === adminUsername && pass === adminPassword) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
  return res.status(401).send('Invalid credentials');
}

// Views
app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/download', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// Health check & self-check
async function runSelfCheck() {
  const checks = {
    env: {
      ADMIN_USERNAME: !!process.env.ADMIN_USERNAME,
      ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
      AIPPT_USERNAME: !!process.env.AIPPT_USERNAME,
      AIPPT_PASSWORD: !!process.env.AIPPT_PASSWORD,
    },
    dataDirWritable: false,
    playwright: { launchOk: false, error: null },
  };
  // data/ writable check
  try {
    const dataDir = path.join(__dirname, 'public', '..', 'data');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
    const testFile = path.join(dataDir, '.write-test');
    fs.writeFileSync(testFile, String(Date.now()));
    fs.rmSync(testFile, { force: true });
    checks.dataDirWritable = true;
  } catch (err) {
    checks.dataDirWritable = false;
  }
  // playwright quick launch
  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
    await browser.close();
    checks.playwright.launchOk = true;
  } catch (err) {
    checks.playwright.launchOk = false;
    checks.playwright.error = err && err.message ? String(err.message) : 'unknown';
  }
  return checks;
}

app.get('/api/health', async (req, res) => {
  try {
    const checks = await runSelfCheck();
    const ok = checks.dataDirWritable && checks.playwright.launchOk;
    res.status(ok ? 200 : 500).json({
      ok,
      version: process.env.npm_package_version || '0.1.0',
      node: process.version,
      port: process.env.PORT || 3000,
      checks,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Helpers
function isTokenValid(tokenRow) {
  if (!tokenRow) return { ok: false, reason: 'not_found' };
  const today = new Date();
  const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at) : null;
  if (expiresAt && expiresAt < new Date(today.toDateString())) {
    return { ok: false, reason: 'expired' };
  }
  if (tokenRow.max_downloads != null && tokenRow.downloads_used >= tokenRow.max_downloads) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true };
}

// Admin APIs
app.get('/api/admin/links', requireAdminAuth, async (req, res) => {
  await db.read();
  const q = (req.query.q || '').toString().trim();
  let rows = [...db.data.tokens];
  if (q) {
    const qLower = q.toLowerCase();
    rows = rows.filter(r =>
      (r.token && r.token.toLowerCase().includes(qLower)) ||
      (r.note && r.note.toLowerCase().includes(qLower))
    );
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  res.json({ data: rows });
});

// Delete token by token string
app.delete('/api/admin/links/:token', requireAdminAuth, async (req, res) => {
  const { token } = req.params;
  await db.read();
  const before = db.data.tokens.length;
  db.data.tokens = db.data.tokens.filter(t => t.token !== token);
  const after = db.data.tokens.length;
  if (after === before) {
    return res.status(404).json({ error: 'not found' });
  }
  await db.write();
  return res.json({ ok: true });
});

app.post('/api/admin/links', requireAdminAuth, async (req, res) => {
  const { count = 1, maxDownloads = null, expiresAt = null, note = '' } = req.body || {};
  const normalizedCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 1000);
  const validDate = expiresAt ? new Date(expiresAt) : null;
  if (expiresAt && isNaN(validDate.getTime())) {
    return res.status(400).json({ error: 'expiresAt must be a valid date (YYYY-MM-DD)' });
  }
  await db.read();
  const nowIso = new Date().toISOString();
  const created = [];
  for (let i = 0; i < normalizedCount; i++) {
    const token = nanoid(24);
    const row = {
      id: ++db.data.seq,
      token,
      max_downloads: maxDownloads != null ? Number(maxDownloads) : null,
      downloads_used: 0,
      expires_at: expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : null,
      note: note || '',
      created_at: nowIso,
    };
    db.data.tokens.push(row);
    created.push({ token });
  }
  await db.write();
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://localhost:3443';
  const links = created.map(x => ({ token: x.token, url: `${baseUrl}/download?token=${encodeURIComponent(x.token)}` }));
  res.json({ data: links });
});

// Export a TXT for a given list of tokens (does not create new tokens)
// POST body: { tokens: string[], count, expiresAt, maxDownloads, note }
app.post('/api/admin/links/export', requireAdminAuth, async (req, res) => {
  const { tokens = [], count = null, expiresAt = null, maxDownloads = null, note = '' } = req.body || {};
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({ error: 'tokens is required' });
  }
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://localhost:3443';
  const urls = tokens.map(t => `${baseUrl}/download?token=${encodeURIComponent(String(t))}`);
  const countLine = count != null ? Number(count) : urls.length;
  const expires = expiresAt ? String(expiresAt) : '不限';
  const limit = (maxDownloads != null && maxDownloads !== '') ? String(maxDownloads) : '不限';
  const noteStr = (note || '').trim() || '无';
  const header = `生成数量：${countLine}，有效期：${expires}，下载次数限制：${limit}，备注：${noteStr}`;
  const content = [header, ...urls].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const now = new Date();
  const fname = `aippt-links-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.txt`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.status(200).send(content);
});

// User APIs
app.get('/api/token/:token', async (req, res) => {
  const { token } = req.params;
  await db.read();
  const row = db.data.tokens.find(t => t.token === token);
  const validity = isTokenValid(row);
  if (!validity.ok) return res.status(404).json({ valid: false });
  const max = row.max_downloads != null ? Number(row.max_downloads) : null;
  const used = Number(row.downloads_used || 0);
  const remaining = max != null ? Math.max(0, max - used) : null;
  res.json({
    valid: true,
    token: row.token,
    downloads_used: used,
    max_downloads: max,
    remaining,
    expires_at: row.expires_at || null,
    note: row.note || ''
  });
});

app.post('/api/download/:token', async (req, res) => {
  const { token } = req.params;
  await db.read();
  const row = db.data.tokens.find(t => t.token === token);
  const validity = isTokenValid(row);
  if (!validity.ok) {
    return res.status(400).json({ error: '该链接无效或已过期/次数已用完' });
  }
  // Increment usage
  const idx = db.data.tokens.findIndex(t => t.id === row.id);
  if (idx >= 0) {
    db.data.tokens[idx].downloads_used += 1;
    // stats: increment downloads
    db.data.stats = db.data.stats || { totalDownloads: 0, totalBytes: 0 };
    db.data.stats.totalDownloads += 1;
    await db.write();
  }

  // Demo file: generate a simple text file as attachment
  const filename = `aippt-template-${token}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200);
  const content = '这是一个示例文件。实际集成可替换为从 aippt.cn 自动化下载的内容。';
  const buf = Buffer.from(content, 'utf-8');
  res.write(buf);
  res.end();
  // update bytes after response sent
  try {
    await db.read();
    db.data.stats = db.data.stats || { totalDownloads: 0, totalBytes: 0 };
    db.data.stats.totalBytes += buf.length;
    await db.write();
  } catch (_) {}
});

// Automated download from aippt.cn by URL (requires valid token via query)
// GET /api/aippt-download?token=...&url=...&headful=true
app.get('/api/aippt-download', async (req, res) => {
  const { token, url } = req.query;
  if (!token || !url) return res.status(400).json({ error: 'missing token or url' });
  await db.read();
  const row = db.data.tokens.find(t => t.token === token);
  const validity = isTokenValid(row);
  if (!validity.ok) return res.status(400).json({ error: '该链接无效或已过期/次数已用完' });
  try {
    const { filePath, filename, cleanup } = await downloadAipptTemplate(String(url), { headless: true });
    // increment usage
    const idx = db.data.tokens.findIndex(t => t.id === row.id);
    if (idx >= 0) {
      db.data.tokens[idx].downloads_used += 1;
      await db.write();
    }
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(filePath);
    stream.on('close', () => cleanup());
    let sentBytes = 0;
    stream.on('data', (chunk) => { sentBytes += chunk.length; });
    stream.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message || '下载失败' });
  }
});

// POST /api/aippt-download  (body: url=...)  Token parsed from Referer of /download?token=...
app.post('/api/aippt-download', async (req, res) => {
  const startTime = Date.now();
  console.log('[timing] POST /api/aippt-download started:', startTime);
  
  try {
    const url = (req.body && (req.body.url || req.body["url"])) || '';
    if (!url) return res.status(400).json({ error: 'missing url' });
    // Validate token from Referer or query
    let tokenFromReferer = null;
    try {
      const ref = req.headers.referer || req.headers.referrer || '';
      if (ref) {
        const u = new URL(ref);
        tokenFromReferer = u.searchParams.get('token');
      }
    } catch (_) {}
    const token = (req.query && req.query.token) || tokenFromReferer || null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    await db.read();
    const row = db.data.tokens.find(t => t.token === token);
    const validity = isTokenValid(row);
    if (!validity.ok) {
      return res.status(400).json({ error: '该链接无效或已过期/次数已用完' });
    }

    console.log('[timing] Starting template download:', Date.now() - startTime, 'ms');
    const { filePath, filename, cleanup } = await downloadAipptTemplate(String(url), { headless: true });
    console.log('[timing] Template downloaded, starting file transfer:', Date.now() - startTime, 'ms');
    
    // Set response headers
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Add file size for progress tracking
    try {
      const stats = fs.statSync(filePath);
      res.setHeader('Content-Length', stats.size);
      console.log('[timing] File size:', stats.size, 'bytes');
    } catch (err) {
      console.log('[timing] Could not get file size:', err.message);
    }
    
    // Add timeout to prevent hanging
    const transferTimeout = setTimeout(() => {
      if (!res.headersSent) {
        console.log('[timing] Transfer timeout, cleaning up');
        cleanup();
        res.status(408).json({ error: 'Transfer timeout' });
      }
    }, 30000); // 30 second timeout
    
    const stream = fs.createReadStream(filePath);
    let sentBytes = 0;
    let transferStartTime = Date.now();
    
    stream.on('open', () => {
      console.log('[timing] File stream opened:', Date.now() - startTime, 'ms');
    });
    
    stream.on('data', (chunk) => { 
      sentBytes += chunk.length;
      if (sentBytes % 1024 === 0) { // Log every 1KB
        console.log('[timing] Transferred:', sentBytes, 'bytes, elapsed:', Date.now() - transferStartTime, 'ms');
      }
    });
    
    stream.on('end', () => {
      console.log('[timing] File transfer completed:', Date.now() - startTime, 'ms, total bytes:', sentBytes);
      clearTimeout(transferTimeout);
    });
    
    stream.on('error', (err) => {
      console.log('[timing] Stream error:', err.message, Date.now() - startTime, 'ms');
      clearTimeout(transferTimeout);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: 'File transfer error' });
      }
    });
    
    // Handle client disconnect
    res.on('close', () => {
      console.log('[timing] Client disconnected, cleaning up');
      clearTimeout(transferTimeout);
      cleanup();
    });
    
    stream.pipe(res);
    
    // increment usage after piping starts
    const idx = db.data.tokens.findIndex(t => t && row && t.id === row.id);
    if (idx >= 0) {
      db.data.tokens[idx].downloads_used += 1;
      // stats: increment downloads & bytes after response ends
      db.data.stats = db.data.stats || { totalDownloads: 0, totalBytes: 0 };
      db.data.stats.totalDownloads += 1;
      await db.write();
      res.on('finish', async () => {
        console.log('[timing] Response finished, updating stats:', Date.now() - startTime, 'ms');
        try {
          await db.read();
          db.data.stats = db.data.stats || { totalDownloads: 0, totalBytes: 0 };
          db.data.stats.totalBytes += sentBytes;
          await db.write();
        } catch (_) {}
      });
    }
  } catch (err) {
    console.log('[timing] Download error:', err.message, Date.now() - startTime, 'ms');
    return res.status(500).json({ error: err.message || '下载失败' });
  }
});

// Admin stats
app.get('/api/admin/stats', requireAdminAuth, async (req, res) => {
  await db.read();
  const s = db.data.stats || { totalDownloads: 0, totalBytes: 0 };
  res.json({
    totalDownloads: s.totalDownloads || 0,
    totalBytes: s.totalBytes || 0
  });
});

// Home
app.get('/', (req, res) => {
  res.redirect('/admin');
});

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// 检查SSL证书是否存在
const sslKeyPath = path.join(__dirname, '..', 'ssl', 'private-key.pem');
const sslCertPath = path.join(__dirname, '..', 'ssl', 'certificate.pem');

if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
  // 启动HTTPS服务器
  const options = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath)
  };
  
  https.createServer(options, app).listen(HTTPS_PORT, () => {
    console.log(`HTTPS Server listening on https://localhost:${HTTPS_PORT}`);
  });
  
  // 同时启动HTTP服务器（重定向到HTTPS）
  app.listen(PORT, () => {
    console.log(`HTTP Server listening on http://localhost:${PORT} (redirects to HTTPS)`);
  });
  
  // HTTP重定向到HTTPS
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      return next();
    }
    return res.redirect(`https://${req.headers.host.replace(/:\d+$/, `:${HTTPS_PORT}`)}${req.url}`);
  });
} else {
  // 如果没有SSL证书，只启动HTTP服务器
  app.listen(PORT, () => {
    console.log(`HTTP Server listening on http://localhost:${PORT}`);
    console.log('SSL certificates not found, running in HTTP mode only');
  });
}


