/**
 * Мок Базы знаний 2.0 (REST 3.0 note.*): ответы формы официальной документации —
 * {result:{item}} / {result:{items,nextCursor}} / {result:{items,hasMore}} / {result:{items,truncated}},
 * ошибки {error:{code,message}} с HTTP 4xx. Состояние в памяти; URL /rest/api/{user}/{secret}/{method}.
 */
import type { MockBitrix, MockResponse, RecordedCall } from './mock-bitrix.js';

export interface NoteCollection {
  id: number;
  name: string;
  position: number;
  policyLevel: string;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDocument {
  id: number;
  collectionId: number | null;
  parentId: number | null;
  title: string;
  markdown: string;
  position: number;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

const TIME = {
  start: 1780639200,
  finish: 1780639200.2,
  duration: 0.2,
  processing: 0.18,
  date_start: '2026-09-25T10:00:00+03:00',
  date_finish: '2026-09-25T10:00:00+03:00',
  operating_reset_at: 1780639800,
  operating: 0,
};

export const v3Ok = (result: unknown): MockResponse => ({ status: 200, body: { result, time: TIME } });
export const v3Error = (code: string, status = 400, message = 'Ошибка'): MockResponse => ({
  status,
  body: { error: { code, message } },
});

const NOT_FOUND = 'BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION';

export class NoteStore {
  collections: NoteCollection[] = [];
  documents = new Map<number, NoteDocument>();
  /** Документы, открытые в редакторе с несохранёнными правками (NOTE_DOCUMENT_HAS_UNSAVED_CHANGES). */
  unsaved = new Set<number>();
  treeTruncated = false;

  /** Изменить текст документа «на портале» (правка коллеги в редакторе). */
  setMarkdown(id: number, markdown: string): void {
    const d = this.documents.get(id);
    if (d) d.markdown = markdown;
  }
  private nextId = 1000;

  collection(id: number, name: string, extra: Partial<NoteCollection> = {}): this {
    this.collections.push({
      id,
      name,
      position: id * 100,
      policyLevel: 'manage',
      createdBy: 7,
      updatedBy: 7,
      createdAt: '2026-09-01T10:00:00Z',
      updatedAt: '2026-09-02T10:00:00Z',
      ...extra,
    });
    return this;
  }

  document(
    id: number,
    collectionId: number | null,
    title: string,
    markdown = '',
    parentId: number | null = null,
  ): this {
    this.documents.set(id, {
      id,
      collectionId,
      parentId,
      title,
      markdown,
      position: id,
      createdBy: 7,
      updatedBy: 7,
      createdAt: '2026-09-01T10:00:00Z',
      updatedAt: '2026-09-01T10:00:00Z',
    });
    return this;
  }

  private tree(collectionId: number, parentId: number | null): unknown[] {
    return [...this.documents.values()]
      .filter((d) => d.collectionId === collectionId && d.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .map((d) => ({
        id: d.id,
        collectionId: d.collectionId,
        parentId: d.parentId,
        title: d.title,
        position: d.position,
        children: this.tree(collectionId, d.id),
      }));
  }

  install(bitrix: MockBitrix): void {
    const body = (c: RecordedCall) => c.body;
    bitrix
      .on('note.collection.list', (c) => {
        const p = (body(c)['pagination'] ?? {}) as {
          limit?: number;
          afterCursor?: { position: number; id: number };
        };
        const limit = p.limit ?? 50;
        const sorted = [...this.collections].sort((a, b) => a.position - b.position || a.id - b.id);
        const after = p.afterCursor;
        const rest = after
          ? sorted.filter(
              (x) => x.position > after.position || (x.position === after.position && x.id > after.id),
            )
          : sorted;
        const items = rest.slice(0, limit);
        const last = items[items.length - 1];
        const more = rest.length > limit && last;
        return v3Ok({ items, nextCursor: more ? { position: last.position, id: last.id } : null });
      })
      .on('note.collection.get', (c) => {
        const item = this.collections.find((x) => x.id === Number(body(c)['id']));
        return item ? v3Ok({ item }) : v3Error(NOT_FOUND);
      })
      .on('note.collection.add', (c) => {
        const fields = body(c)['fields'] as { name: string; position?: number };
        const id = this.nextId++;
        this.collection(id, fields.name, { position: fields.position ?? 0 });
        return v3Ok({ item: this.collections.find((x) => x.id === id) });
      })
      .on('note.document.tree.list', (c) => {
        const collectionId = Number(body(c)['collectionId']);
        if (!this.collections.some((x) => x.id === collectionId)) return v3Error(NOT_FOUND);
        return v3Ok({ items: this.tree(collectionId, null), truncated: this.treeTruncated });
      })
      .on('note.document.get', (c) => {
        const item = this.documents.get(Number(body(c)['id']));
        return item ? v3Ok({ item }) : v3Error(NOT_FOUND);
      })
      .on('note.document.search.list', (c) => {
        const raw = body(c)['query'];
        const q = (typeof raw === 'string' ? raw : '').toLowerCase();
        const limit = ((body(c)['pagination'] ?? {}) as { limit?: number }).limit ?? 50;
        const found = [...this.documents.values()].filter(
          (d) => d.title.toLowerCase().includes(q) || d.markdown.toLowerCase().includes(q),
        );
        return v3Ok({
          items: found.slice(0, limit).map((d, i) => ({
            documentId: d.id,
            collectionId: d.collectionId,
            title: d.title,
            score: 0.9 - i * 0.01,
            snippet: `...<b>${q}</b> &amp; ещё...`,
            sharedAccess: false,
          })),
          hasMore: found.length > limit,
        });
      })
      .on('note.document.add', (c) => {
        const f = body(c)['fields'] as {
          collectionId: number;
          title: string;
          parentId?: number;
          markdown?: string;
        };
        if (!this.collections.some((x) => x.id === f.collectionId)) return v3Error(NOT_FOUND);
        if (f.parentId !== undefined && this.documents.get(f.parentId)?.collectionId !== f.collectionId) {
          return v3Error('NOTE_INVALID_PARENT');
        }
        const id = this.nextId++;
        this.document(id, f.collectionId, f.title, f.markdown ?? '', f.parentId ?? null);
        return v3Ok({ item: this.documents.get(id) });
      })
      .on('note.document.update', (c) => {
        const id = Number(body(c)['id']);
        const doc = this.documents.get(id);
        if (!doc) return v3Error(NOT_FOUND);
        const f = body(c)['fields'] as { title?: string; markdown?: string };
        if (f.markdown !== undefined && this.unsaved.has(id) && body(c)['overwrite'] !== true) {
          return v3Error('NOTE_DOCUMENT_HAS_UNSAVED_CHANGES', 400, 'The document has unsaved changes');
        }
        if (f.title !== undefined) doc.title = f.title;
        if (f.markdown !== undefined) doc.markdown = f.markdown;
        doc.updatedAt = '2026-09-25T10:00:00Z';
        this.unsaved.delete(id);
        return v3Ok({ item: doc });
      });
  }
}
