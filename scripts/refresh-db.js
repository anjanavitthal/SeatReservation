'use strict';
const fs = require('fs');
const path = require('path');
const { openDb, seed } = require('../src/db');

const dbPath = process.env.DB_FILE || path.join('data', 'bus.db');
const dir = path.dirname(dbPath);

for (const file of ['bus.db', 'bus.db-wal', 'bus.db-shm']) {
  const target = path.join(dir, file);
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
}

const db = openDb(dbPath);
seed(db);
console.log(`SQLite DB refreshed: ${dbPath}`);
db.close();
