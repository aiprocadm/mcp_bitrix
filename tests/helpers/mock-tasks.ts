/**
 * Мок-портал задач для полной версии (ТЗ §9.8): задачи, REST 3.0 tasks.task.get, чек-листы, комментарии, чат.
 * Формы ответов — по страницам документации (result.task / result.item / result:{result:true} / массивы UPPER_CASE).
 * Методы старого API task.checklistitem.* и task.commentitem.* разбирают тело ПОЗИЦИОННО (как портал):
 * нарушение порядка ключей даёт тот же эффект, что и в Bitrix24 (false / «не найдено»).
 */
import {
  legacyError,
  legacyOk,
  TASK_FIELDS,
  taskRecord,
  type MockBitrix,
  type MockResponse,
} from './mock-bitrix.js';

export interface V3Flags {
  requireResult: boolean;
  containsResults: boolean;
  needsControl: boolean;
}

export interface ChatMessage {
  id: number;
  chat_id: number;
  author_id: number;
  date: string;
  text: string;
  unread: boolean;
  params: Record<string, unknown> | unknown[];
}

const camel = (upper: string): string => {
  const [head = '', ...rest] = upper.toLowerCase().split('_');
  return head + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
};

export class TasksPortal {
  readonly tasks = new Map<number, Record<string, unknown>>();
  readonly flags = new Map<number, V3Flags>();
  /** Сырые пункты чек-листа (форма task.checklistitem.getlist). */
  checklist: Record<string, unknown>[] = [];
  comments: Record<string, unknown>[] = [];
  readonly chats = new Map<number, ChatMessage[]>();
  v3Available = true;
  chatAccessDenied = false;
  private seq = 1000;
  private changeSeq = 0;

  constructor() {
    // 100 — старая карточка, без чата
    this.addTask(100, { commentsCount: '2' });
    // 200 — новая карточка: chatId=58
    this.addTask(200, { chatId: 58 });
    this.flags.set(200, { requireResult: false, containsResults: false, needsControl: false });
    this.chats.set(58, [
      this.msg(58, 501, 7, 'Первое сообщение'),
      this.msg(58, 502, 0, '[USER=7]Иван[/USER] присоединился к чату'),
      this.msg(58, 503, 12, 'Второе сообщение'),
    ]);
    this.comments = [
      {
        ID: '3155',
        AUTHOR_ID: '7',
        AUTHOR_NAME: 'Иван Тестов',
        AUTHOR_EMAIL: 'ivan@example.com',
        POST_DATE: '2026-09-20T10:00:00+03:00',
        POST_MESSAGE: 'Старый комментарий',
        ATTACHED_OBJECTS: {},
      },
      {
        ID: '3157',
        AUTHOR_ID: '12',
        AUTHOR_NAME: 'Пётр',
        AUTHOR_EMAIL: 'petr@example.com',
        POST_DATE: '2026-09-21T10:00:00+03:00',
        POST_MESSAGE: 'Фото приложены',
        ATTACHED_OBJECTS: {
          '973': {
            ATTACHMENT_ID: '973',
            NAME: 'p.png',
            DOWNLOAD_URL: '/bitrix/tools/disk/uf.php?auth=secret',
          },
        },
      },
    ];
    // Чек-лист задачи 100: корень 431 → 433 (выполнен), 447 → 469; корень 600 отдельно; пункт 900 — другой задачи
    this.checklist = [
      this.item(447, 100, 431, 'Согласовать детали', 1, 'N'),
      this.item(431, 100, 0, 'Чек-лист 1', 0, 'N'),
      this.item(469, 100, 447, 'Согласовать с руководителем', 0, 'N'),
      this.item(433, 100, 431, 'Найти документы', 0, 'Y'),
      this.item(600, 100, 0, 'Чек-лист 2', 1, 'N'),
      this.item(900, 777, 0, 'Чужая задача', 0, 'N'),
    ];
  }

  addTask(id: number, overrides: Record<string, unknown> = {}): void {
    this.tasks.set(
      id,
      taskRecord(id, {
        taskControl: 'N',
        commentsCount: '0',
        changedDate: '2026-09-23T10:00:00+03:00',
        action: { edit: true, complete: true, remove: true },
        ...overrides,
      }),
    );
  }

  msg(chatId: number, id: number, author: number, text: string): ChatMessage {
    return {
      id,
      chat_id: chatId,
      author_id: author,
      date: '2026-09-24T10:00:00+03:00',
      text,
      unread: false,
      params: [],
    };
  }

  item(id: number, taskId: number, parentId: number, title: string, sort: number, done: 'Y' | 'N') {
    return {
      ID: String(id),
      TASK_ID: String(taskId),
      PARENT_ID: parentId === 0 ? 0 : String(parentId),
      CREATED_BY: '7',
      TITLE: title,
      SORT_INDEX: String(sort),
      IS_COMPLETE: done,
      IS_IMPORTANT: 'N',
      TOGGLED_BY: done === 'Y' ? '7' : null,
      TOGGLED_DATE: done === 'Y' ? '2026-09-20T10:00:00+03:00' : '',
      MEMBERS: [
        {
          ID: '12',
          TYPE: 'A',
          NAME: 'Пётр',
          PERSONAL_PHOTO: '1',
          IMAGE: 'https://x.invalid/a.png',
          IS_COLLABER: false,
        },
      ],
      ATTACHMENTS: [],
    };
  }

  touch(id: number): void {
    const t = this.tasks.get(id);
    if (t)
      t['changedDate'] = `2026-09-24T10:00:${String(10 + (this.changeSeq++ % 50)).padStart(2, '0')}+03:00`;
  }

  install(bitrix: MockBitrix): void {
    const isV3 = (url: string) => url.includes('/rest/api/');
    bitrix
      .on('tasks.task.getfields', legacyOk(TASK_FIELDS))
      .on('tasks.task.get', (c) =>
        isV3(c.url) ? this.v3Get(Number(c.body['id'])) : this.legacyGet(Number(c.body['taskId'])),
      )
      .on('tasks.task.update', (c) => {
        const t = this.tasks.get(Number(c.body['taskId']));
        if (!t) return legacyError('0', 400, 'Action on the task is not allowed');
        for (const [k, v] of Object.entries(c.body['fields'] as Record<string, unknown>)) t[camel(k)] = v;
        this.touch(Number(c.body['taskId']));
        return legacyOk({ task: t });
      })
      .on('tasks.task.complete', (c) => {
        const id = Number(c.body['taskId']);
        const t = this.tasks.get(id);
        if (!t) return legacyError('0', 400, 'Action on the task is not allowed');
        const f = this.flags.get(id);
        if (f?.requireResult && !f.containsResults) return legacyError('ERROR_CORE', 400, 'Result required');
        t['status'] = t['taskControl'] === 'Y' || f?.needsControl ? '4' : '5';
        this.touch(id);
        return legacyOk({ task: t });
      })
      .on('tasks.task.delete', (c) => {
        const id = Number(c.body['taskId']);
        if (!this.tasks.delete(id)) return legacyError('1048582', 400, 'No access to delete the task');
        return legacyOk({ task: true });
      })
      .on('tasks.task.list', (c) => {
        const filter = (c.body['filter'] ?? {}) as Record<string, unknown>;
        const list = [...this.tasks.values()].filter(
          (t) =>
            filter['PARENT_ID'] === undefined ||
            String(t['parentId']) === String(filter['PARENT_ID'] as number),
        );
        return legacyOk(
          { tasks: list.map((t) => ({ id: t['id'], title: t['title'] })) },
          { total: list.length },
        );
      })
      .on('task.checklistitem.getlist', (c) => {
        const [taskId] = Object.values(c.body);
        return legacyOk(this.checklist.filter((i) => String(i['TASK_ID']) === String(taskId)));
      })
      .on('task.checklistitem.add', (c) => {
        const [taskId, fields] = Object.values(c.body) as [unknown, Record<string, unknown>];
        const id = this.seq++;
        const parent = Number(fields['PARENT_ID'] ?? 431);
        this.checklist.push(this.item(id, Number(taskId), parent, String(fields['TITLE']), 99, 'N'));
        return legacyOk(id);
      })
      .on('task.checklistitem.update', (c) => {
        const [, itemId, fields] = Object.values(c.body) as [unknown, unknown, Record<string, unknown>];
        const it = this.checklist.find((i) => Number(i['ID']) === Number(itemId));
        if (!it || typeof fields !== 'object')
          return legacyError('ERROR_CORE', 400, 'Incorrect value [] for field [ENTITY_ID]');
        for (const [k, v] of Object.entries(fields)) it[k] = typeof v === 'number' ? String(v) : v;
        return legacyOk(null);
      })
      .on('task.checklistitem.complete', (c) => this.toggle(c.body, 'Y'))
      .on('task.checklistitem.renew', (c) => this.toggle(c.body, 'N'))
      .on('task.checklistitem.delete', (c) => {
        const [, itemId] = Object.values(c.body);
        const before = this.checklist.length;
        const doomed = new Set([Number(itemId)]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const i of this.checklist)
            if (doomed.has(Number(i['PARENT_ID'])) && !doomed.has(Number(i['ID']))) {
              doomed.add(Number(i['ID']));
              grew = true;
            }
        }
        this.checklist = this.checklist.filter((i) => !doomed.has(Number(i['ID'])));
        return legacyOk(this.checklist.length < before);
      })
      .on('task.commentitem.getlist', (c) => {
        const [taskId, , filter] = Object.values(c.body) as [unknown, unknown, Record<string, unknown>];
        if (Number(taskId) !== 100) return legacyOk([]);
        let list = [...this.comments];
        if (filter?.['<ID'] !== undefined) list = list.filter((x) => Number(x['ID']) < Number(filter['<ID']));
        if (filter?.['ID'] !== undefined) list = list.filter((x) => Number(x['ID']) === Number(filter['ID']));
        return legacyOk(list.sort((a, b) => Number(b['ID']) - Number(a['ID'])));
      })
      .on('task.commentitem.add', (c) => {
        const [taskId, fields] = Object.values(c.body) as [unknown, Record<string, unknown>];
        const id = this.seq++;
        if (Number(taskId) === 100)
          this.comments.push({
            ID: String(id),
            AUTHOR_ID: '7',
            AUTHOR_NAME: 'Иван',
            POST_DATE: '2026-09-24T12:00:00+03:00',
            POST_MESSAGE: fields['POST_MESSAGE'],
            ATTACHED_OBJECTS: {},
          });
        return legacyOk(id);
      })
      .on('tasks.task.chat.message.send', (c) => {
        if (!this.v3Available) return this.v3NotFound();
        const fields = c.body['fields'] as Record<string, unknown>;
        const t = this.tasks.get(Number(fields['taskId']));
        const chatId = Number(t?.['chatId']);
        const list = this.chats.get(chatId);
        if (!list)
          return {
            status: 400,
            body: {
              error: { code: 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION', message: 'Access denied' },
            },
          };
        list.push(this.msg(chatId, 600 + list.length, 7, String(fields['text'])));
        return { status: 200, body: { result: { result: true }, time: {} } };
      })
      .on('im.dialog.messages.get', (c) => {
        if (this.chatAccessDenied)
          return legacyError('ACCESS_ERROR', 403, 'You do not have access to the specified dialog');
        const chatId = Number(String(c.body['DIALOG_ID']).replace(/^chat/, ''));
        const limit = Number(c.body['LIMIT'] ?? 20);
        let list = [...(this.chats.get(chatId) ?? [])].sort((a, b) => b.id - a.id);
        if (c.body['LAST_ID'] !== undefined) list = list.filter((m) => m.id < Number(c.body['LAST_ID']));
        return legacyOk({ chat_id: chatId, messages: list.slice(0, limit), users: [], files: [] });
      });
  }

  private toggle(body: Record<string, unknown>, value: 'Y' | 'N'): MockResponse {
    // Позиционно: [0] = taskId, [1] = itemId. Портал не проверяет принадлежность пункта задаче.
    const [, itemId] = Object.values(body);
    const it = this.checklist.find((i) => Number(i['ID']) === Number(itemId));
    if (!it) return legacyOk(false);
    it['IS_COMPLETE'] = value;
    return legacyOk(true);
  }

  private legacyGet(id: number): MockResponse {
    const t = this.tasks.get(id);
    return t ? legacyOk({ task: t }) : legacyError('ERROR_NOT_FOUND', 400, 'Task not found');
  }

  private v3NotFound(): MockResponse {
    return { status: 404, body: { error: { code: 'METHOD_NOT_FOUND', message: 'Method not found' } } };
  }

  private v3Get(id: number): MockResponse {
    if (!this.v3Available) return this.v3NotFound();
    const t = this.tasks.get(id);
    if (!t)
      return {
        status: 400,
        body: { error: { code: 'BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION', message: 'not found' } },
      };
    const f = this.flags.get(id) ?? { requireResult: false, containsResults: false, needsControl: false };
    return {
      status: 200,
      body: {
        result: { item: { id, ...f, chatId: t['chatId'] ?? null } },
        time: {},
      },
    };
  }
}
