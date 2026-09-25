/**
 * Объявления в кабинете клиента (SaaS-ТЗ §11.3): владелец публикует, кабинет (`/app`) показывает действующие.
 * Таблица `announcements` — каталог без RLS; `tenant_id NULL` — всем арендаторам. Текст — от владельца, не от
 * клиента; при выводе в HTML его всё равно экранирует страница.
 */
import { AppError } from '../../errors/app-error.js';
import { toNumber, type SqlExecutor } from '../../storage/sql.js';

export type AnnouncementLevel = 'info' | 'warning' | 'critical';

export interface Announcement {
  id: number;
  tenantId: string | null;
  level: AnnouncementLevel;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export interface AnnouncementInput {
  tenantId: string | null;
  level: AnnouncementLevel;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
}

interface Row {
  id: number | string;
  tenant_id: string | null;
  level: AnnouncementLevel;
  title: string;
  body: string;
  starts_at: string;
  ends_at: string | null;
  active: number | string;
  created_by: string;
  created_at: string;
}

const toAnnouncement = (r: Row): Announcement => ({
  id: toNumber(r.id),
  tenantId: r.tenant_id,
  level: r.level,
  title: r.title,
  body: r.body,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  active: toNumber(r.active) === 1,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export function validateAnnouncement(a: AnnouncementInput): AnnouncementInput {
  const title = a.title.trim();
  const body = a.body.trim();
  if (!['info', 'warning', 'critical'].includes(a.level))
    throw new AppError('VALIDATION_ERROR', 'Уровень объявления: info, warning или critical', {
      field: 'level',
    });
  if (!title || title.length > 200)
    throw new AppError('VALIDATION_ERROR', 'Заголовок — от 1 до 200 символов', { field: 'title' });
  if (!body || body.length > 4000)
    throw new AppError('VALIDATION_ERROR', 'Текст — от 1 до 4000 символов', { field: 'body' });
  for (const [field, v] of [
    ['startsAt', a.startsAt],
    ['endsAt', a.endsAt],
  ] as const) {
    if (v !== null && Number.isNaN(Date.parse(v)))
      throw new AppError('VALIDATION_ERROR', 'Некорректная дата', { field });
  }
  if (a.endsAt !== null && Date.parse(a.endsAt) <= Date.parse(a.startsAt))
    throw new AppError('VALIDATION_ERROR', 'Окончание показа — позже начала', { field: 'endsAt' });
  return {
    ...a,
    title,
    body,
    startsAt: new Date(a.startsAt).toISOString(),
    endsAt: a.endsAt === null ? null : new Date(a.endsAt).toISOString(),
  };
}

export const Announcements = {
  async insert(x: SqlExecutor, a: AnnouncementInput, createdBy: string, at: string): Promise<number> {
    const r = await x.get<{ id: unknown }>(
      `INSERT INTO announcements (tenant_id, level, title, body, starts_at, ends_at, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING id`,
      a.tenantId,
      a.level,
      a.title,
      a.body,
      a.startsAt,
      a.endsAt,
      createdBy,
      at,
      at,
    );
    return toNumber(r?.id);
  },

  async deactivate(x: SqlExecutor, id: number, at: string): Promise<boolean> {
    return (
      (await x.run(
        'UPDATE announcements SET active = 0, updated_at = ? WHERE id = ? AND active = 1',
        at,
        id,
      )) === 1
    );
  },

  async get(x: SqlExecutor, id: number): Promise<Announcement | undefined> {
    const r = await x.get<Row>('SELECT * FROM announcements WHERE id = ?', id);
    return r ? toAnnouncement(r) : undefined;
  },

  async list(x: SqlExecutor, limit = 100): Promise<Announcement[]> {
    const rows = await x.all<Row>(
      'SELECT * FROM announcements ORDER BY created_at DESC, id DESC LIMIT ?',
      limit,
    );
    return rows.map(toAnnouncement);
  },

  /** Для кабинета: действующие сейчас объявления арендатора (общие и адресные), сначала важные. */
  async activeFor(x: SqlExecutor, tenantId: string, at: string): Promise<Announcement[]> {
    const rows = await x.all<Row>(
      `SELECT * FROM announcements
       WHERE active = 1 AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
         AND (tenant_id IS NULL OR tenant_id = ?)
       ORDER BY CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, starts_at DESC LIMIT 20`,
      at,
      at,
      tenantId,
    );
    return rows.map(toAnnouncement);
  },
};
