'use strict';
const {DatabaseSync} = require('node:sqlite');
class Store {
  constructor(filename, mode = 'durable') {
    this.db = new DatabaseSync(mode === 'memory' ? ':memory:' : filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (mode === 'durable') this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS grants (
      grant_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
      last_hash TEXT NOT NULL DEFAULT 'GENESIS');
    CREATE TABLE IF NOT EXISTS ops (
      op_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES grants(grant_id),
      seq INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','DONE')),
      admitted_at INTEGER NOT NULL, previous_hash TEXT NOT NULL, request TEXT NOT NULL,
      record TEXT, ack TEXT, synced INTEGER NOT NULL DEFAULT 0, tx_hash TEXT,
      UNIQUE(grant_id,seq), CHECK(synced=0 OR state='DONE'));
    CREATE TABLE IF NOT EXISTS robot_receipts (
      op_id TEXT PRIMARY KEY, command_hash TEXT NOT NULL, command TEXT NOT NULL,
      ack TEXT NOT NULL, effect_count INTEGER NOT NULL CHECK(effect_count=1));`);
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  begin() { this.db.exec('BEGIN IMMEDIATE'); }
  commit() { this.db.exec('COMMIT'); }
  rollback() { this.db.exec('ROLLBACK'); }
  settings() { return {journal_mode:this.get('PRAGMA journal_mode').journal_mode,
    synchronous:this.get('PRAGMA synchronous').synchronous, sqlite:this.get('SELECT sqlite_version() AS v').v}; }
  snapshot() { return {settings:this.settings(), grants:this.all('SELECT * FROM grants ORDER BY grant_id'),
    ops:this.all('SELECT * FROM ops ORDER BY grant_id,seq'), robot:this.all('SELECT * FROM robot_receipts ORDER BY op_id')}; }
  close() {
    // DELETE journal mode keeps the archival database self-contained after a commit.
    // Recovery of an interrupted transaction still uses SQLite's hot rollback journal.
    this.db.close();
  }
}
module.exports = {Store};
