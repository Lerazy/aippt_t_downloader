import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { getDb, initDb } from './db.js';
import { downloadAipptTemplate } from './services/aipptDownloader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = getDb();
await initDb();

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
  const rows = [...db.data.tokens].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  res.json({ data: rows });
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
  const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  const links = created.map(x => ({ token: x.token, url: `${baseUrl}/download?token=${encodeURIComponent(x.token)}` }));
  res.json({ data: links });
});

// User APIs
app.get('/api/token/:token', async (req, res) => {
  const { token } = req.params;
  await db.read();
  const row = db.data.tokens.find(t => t.token === token);
  const validity = isTokenValid(row);
  if (!validity.ok) return res.status(404).json({ valid: false });
  res.json({ valid: true });
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
    await db.write();
  }

  // Demo file: generate a simple text file as attachment
  const filename = `aippt-template-${token}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200);
  res.write('这是一个示例文件。实际集成可替换为从 aippt.cn 自动化下载的内容。');
  res.end();
});

// Automated download from aippt.cn by URL (requires valid token via query)
// GET /api/aippt-download?token=...&url=...&headful=true
app.get('/api/aippt-download', async (req, res) => {
  const { token, url, headful } = req.query;
  if (!token || !url) return res.status(400).json({ error: 'missing token or url' });
  await db.read();
  const row = db.data.tokens.find(t => t.token === token);
  const validity = isTokenValid(row);
  if (!validity.ok) return res.status(400).json({ error: '该链接无效或已过期/次数已用完' });
  try {
    const { filePath, filename, cleanup } = await downloadAipptTemplate(String(url), { headless: headful ? false : undefined });
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
    stream.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message || '下载失败' });
  }
});

// POST /api/aippt-download  (body: url=...)  Token parsed from Referer of /download?token=...
app.post('/api/aippt-download', async (req, res) => {
  try {
    const url = (req.body && (req.body.url || req.body["url"])) || '';
    if (!url) return res.status(400).json({ error: 'missing url' });

    const { filePath, filename, cleanup } = await downloadAipptTemplate(String(url), { headless: false, slowMo: 250 });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(filePath);
    stream.on('close', () => cleanup());
    stream.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message || '下载失败' });
  }
});

// Home
app.get('/', (req, res) => {
  res.redirect('/admin');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});


