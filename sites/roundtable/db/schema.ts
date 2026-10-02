import {integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

// Private backend capabilities never enter model tool results or browser state.
export const runCapabilities = sqliteTable('run_capabilities', {
  userId: text('user_id').notNull(),
  roomId: text('room_id').notNull(),
  runId: text('run_id').notNull(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lockId: text('lock_id'),
  lockedUntil: integer('locked_until'),
}, table => [primaryKey({columns:[table.userId, table.roomId, table.runId]})]);
