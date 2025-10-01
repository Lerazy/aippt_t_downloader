import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dbInstance;

export function getDb() {
  if (dbInstance) return dbInstance;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'app.json');
  const adapter = new JSONFile(dbPath);
  const db = new Low(adapter, { tokens: [], seq: 0, stats: { totalDownloads: 0, totalBytes: 0 } });
  dbInstance = db;
  return dbInstance;
}

export async function initDb() {
  const db = getDb();
  await db.read();
  db.data = db.data || { tokens: [], seq: 0, stats: { totalDownloads: 0, totalBytes: 0 } };
  // Backfill missing fields for older data files
  if (!db.data.stats) {
    db.data.stats = { totalDownloads: 0, totalBytes: 0 };
  }
  await db.write();
  return db;
}


