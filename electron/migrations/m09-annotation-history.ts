import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M09_ANNOTATION_HISTORY_SQL = `
CREATE TABLE annotation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts_all(id) ON DELETE CASCADE,
  before_text TEXT NOT NULL,
  after_text TEXT NOT NULL,
  annotations_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_annotation_history_draft ON annotation_history(draft_id, id);
`

export function applyM09AnnotationHistory(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('M09_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M09_ANNOTATION_HISTORY_SQL)
}

export function createM09Migration(deps: { database(reader: SchemaReader): Database.Database; verifyKnownSchema(reader: SchemaReader): boolean }): MigrationImplementation {
  return { id: 'M09', from: 9, to: 10, owner: 'annotation-history',
    migrate: reader => applyM09AnnotationHistory(deps.database(reader)), verify: reader => deps.verifyKnownSchema(reader) }
}
