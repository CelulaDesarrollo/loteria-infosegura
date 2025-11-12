import { Database } from 'sqlite3';
import { join } from 'path';

const dbPath = join(__dirname, '../../data/loteria.db');

export const db = new Database(dbPath);

// Mejoras de concurrencia para SQLite (WAL + timeout)
try {
  // mejor rendimiento concurrente
  db.pragma("journal_mode = WAL");
  // durabilidad razonable
  db.pragma("synchronous = NORMAL");
  // espera hasta 5s si DB está bloqueada por otra transacción
  db.pragma("busy_timeout = 5000");
} catch (e) {
  console.warn("[database] no se pudo aplicar pragmas WAL/busy_timeout:", e);
}

// Async wrappers con tipos simples
export const dbRunAsync = (sql: string, params: any[] = []): Promise<void> =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });

export const dbGetAsync = <T = any>(sql: string, params: any[] = []): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row as T | undefined);
    });
  });

export const dbAllAsync = <T = any>(sql: string, params: any[] = []): Promise<T[]> =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows as T[]);
    });
  });

// Initialize table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});