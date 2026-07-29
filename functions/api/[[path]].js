// ============================================================
//  Рекламный трекер OZON — серверный API (Cloudflare Pages Functions)
//  Файл ловит все запросы /api/*. Требует привязку D1 с именем "DB".
//  Идентификация: имя пользователя приходит в заголовке X-User
//  (сайт целиком закрыт общим паролем на фронте, отдельных паролей нет).
// ============================================================

// Модели Workers AI (пробуются по порядку; если одна устарела/недоступна — берётся следующая).
// Cloudflare на 2026 рекомендует Llama 4. Порядок можно менять под качество/скорость.
const AI_MODELS = [
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/qwen/qwen2.5-7b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/openai/gpt-oss-20b",
];

const SYS_STRATEGY = "Ты — старший маркетолог-аналитик маркетплейса OZON. На основе истории комментариев команды по ОДНОМУ товару выдели рабочую СТРАТЕГИЮ ПРОДВИЖЕНИЯ: что для этого товара сработало хорошо и как это масштабировать. " +
  "Опирайся ТОЛЬКО на факты из комментариев и метрики товара, ничего не выдумывай; если данных мало — честно укажи это. " +
  "Формат СТРОГО: 3–6 пунктов, каждый с новой строки и начинается с «— » (тире). Без вводных фраз (не начинай с «На основе…», «Можно выделить…»). Без Markdown: не используй звёздочки (*, **), решётки (#) и любое форматирование. Только суть — что делать и почему это сработало. Отвечай на русском. " +
  "Учитывай практику OZON: инструменты (Оплата за клик/ОЗК, Оплата за заказ/ОЗЗ, Медийная, Трафареты), ДРР как ключевую метрику эффективности, влияние на СПП и индекс цен, важность остатков и качества карточки. Рекомендации должны быть применимы в кабинете OZON.";

const SYS_PAIN = "Ты — старший маркетолог-аналитик маркетплейса OZON. На основе истории комментариев команды по ОДНОМУ товару составь КАРТУ БОЛИ: что для этого товара НЕ работает и чего делать НЕЛЬЗЯ. " +
  "Опирайся ТОЛЬКО на факты из комментариев и метрики, ничего не выдумывай; если данных мало — честно укажи это. " +
  "Формат СТРОГО: 3–6 пунктов, каждый с новой строки и начинается с «— » (тире). Без вводных фраз. Без Markdown: не используй звёздочки (*, **), решётки (#) и форматирование. Только суть — что не делать и почему это навредило (рост ДРР, слив бюджета, падение выручки). Отвечай на русском. " +
  "Учитывай практику OZON (ОЗК/ОЗЗ/Медийная/Трафареты, ДРР, СПП, индекс цен, остатки, контент карточки). Рекомендации применимы в кабинете OZON.";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function author(request) {
  let u = request.headers.get("X-User") || "";
  try { u = decodeURIComponent(u); } catch (e) {}
  u = (u || "").trim().slice(0, 60);
  return u || "аноним";
}

const now = () => Date.now();

// ---- сериализация строк БД в формат, который ждёт фронт ----
function commentsLatest(rows) {
  // rows: последняя запись по каждой РК → { [camp_id]: {text, author, ts} }
  const out = {};
  for (const r of rows) out[r.camp_id] = { text: r.text, author: r.author, ts: r.created_at };
  return out;
}
function statusesMap(rows) {
  const out = {};
  for (const r of rows) {
    out[r.camp_id] = {
      action: r.action, comment: r.comment || "", from: r.from_status || null,
      period: r.period || "", restartDate: r.restart_date || "",
      author: r.author || "", ts: r.updated_at,
    };
  }
  return out;
}
function feedRows(rows) {
  return rows.map((e) => ({
    id: e.id, kind: e.kind, camp_id: e.camp_id, author: e.author,
    action: e.action || null, text: e.text || "", from_status: e.from_status || null,
    created_at: e.created_at,
  }));
}

async function readComments(db) {
  const { results } = await db
    .prepare("SELECT camp_id, author, text, created_at FROM comments WHERE id IN (SELECT MAX(id) FROM comments GROUP BY camp_id)")
    .all();
  return commentsLatest(results || []);
}
async function readCommentsAll(db, limit = 4000) {
  const { results } = await db
    .prepare("SELECT camp_id, author, text, created_at FROM comments ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all();
  const rows = results || [];
  const out = {};
  // rows приходят новыми-сначала; собираем треды старыми-сначала
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    (out[r.camp_id] = out[r.camp_id] || []).push({ author: r.author, text: r.text, ts: r.created_at });
  }
  return out;
}
async function readStatuses(db) {
  const { results } = await db
    .prepare("SELECT camp_id, action, comment, from_status, period, restart_date, author, updated_at FROM statuses")
    .all();
  return statusesMap(results || []);
}
async function readFeed(db, limit = 300) {
  const { results } = await db
    .prepare("SELECT id, kind, camp_id, author, action, text, from_status, created_at FROM events ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all();
  return feedRows(results || []);
}
async function readSnapshots(db) {
  const { results } = await db
    .prepare("SELECT report_date, data, author, updated_at FROM snapshots")
    .all();
  return (results || []).map((r) => {
    let snap;
    try { snap = JSON.parse(r.data); } catch (e) { snap = null; }
    return snap; // фронт ожидает массив снапшот-объектов (как DB.load())
  }).filter(Boolean);
}
async function readUsers(db) {
  const { results } = await db.prepare("SELECT name FROM users ORDER BY name").all();
  return (results || []).map((r) => r.name);
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return err("D1 binding 'DB' не настроен на проекте", 500);

  const url = new URL(request.url);
  // path без префикса /api
  let path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "");
  if (path === "") path = "/";
  const method = request.method.toUpperCase();

  try {
    // -------- health --------
    if (path === "/health") {
      return json({ ok: true, ts: now() });
    }

    // -------- полная выгрузка при старте --------
    if (path === "/bootstrap" && method === "GET") {
      const [commentsAll, statuses, feed, snapshots, users] = await Promise.all([
        readCommentsAll(db), readStatuses(db), readFeed(db), readSnapshots(db), readUsers(db),
      ]);
      return json({ ok: true, shared: true, commentsAll, statuses, feed, snapshots, users });
    }

    // -------- лёгкий поллинг (без снапшотов) --------
    if (path === "/sync" && method === "GET") {
      const [commentsAll, statuses, feed] = await Promise.all([
        readCommentsAll(db), readStatuses(db), readFeed(db),
      ]);
      return json({ ok: true, commentsAll, statuses, feed });
    }

    // -------- пользователи --------
    if (path === "/users" && method === "GET") {
      return json({ ok: true, users: await readUsers(db) });
    }
    if (path === "/user" && method === "POST") {
      const name = author(request);
      await db.prepare("INSERT OR IGNORE INTO users (name, created_at) VALUES (?, ?)")
        .bind(name, now()).run();
      return json({ ok: true });
    }

    // -------- комментарий (append в тред + событие в ленту) --------
    if (path === "/comment" && method === "POST") {
      const body = await request.json();
      const camp = String(body.camp_id || "").slice(0, 200);
      const text = String(body.text || "").trim().slice(0, 4000);
      if (!camp) return err("camp_id обязателен");
      const who = author(request);
      const t = now();
      if (text) {
        await db.batch([
          db.prepare("INSERT INTO comments (camp_id, author, text, created_at) VALUES (?, ?, ?, ?)")
            .bind(camp, who, text, t),
          db.prepare("INSERT INTO events (kind, camp_id, author, action, text, from_status, created_at) VALUES ('comment', ?, ?, NULL, ?, NULL, ?)")
            .bind(camp, who, text, t),
        ]);
      }
      return json({ ok: true, ts: t });
    }

    // -------- статус (upsert + событие) --------
    if (path === "/status" && method === "POST") {
      const body = await request.json();
      const camp = String(body.camp_id || "").slice(0, 200);
      if (!camp) return err("camp_id обязателен");
      const o = body.obj || {};
      const who = author(request);
      const t = now();
      await db.batch([
        db.prepare(
          "INSERT INTO statuses (camp_id, action, comment, from_status, period, restart_date, author, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(camp_id) DO UPDATE SET action=excluded.action, comment=excluded.comment, " +
          "from_status=excluded.from_status, period=excluded.period, restart_date=excluded.restart_date, " +
          "author=excluded.author, updated_at=excluded.updated_at"
        ).bind(camp, o.action || null, o.comment || "", o.from || null, o.period || "", o.restartDate || "", who, t),
        db.prepare("INSERT INTO events (kind, camp_id, author, action, text, from_status, created_at) VALUES ('status', ?, ?, ?, ?, ?, ?)")
          .bind(camp, who, o.action || null, o.comment || "", o.from || null, t),
      ]);
      return json({ ok: true, ts: t });
    }
    if (path === "/status" && method === "DELETE") {
      const camp = String(url.searchParams.get("camp_id") || "").slice(0, 200);
      if (!camp) return err("camp_id обязателен");
      const who = author(request);
      const t = now();
      await db.batch([
        db.prepare("DELETE FROM statuses WHERE camp_id = ?").bind(camp),
        db.prepare("INSERT INTO events (kind, camp_id, author, action, text, from_status, created_at) VALUES ('status', ?, ?, 'undo', 'Вернули в работу', NULL, ?)")
          .bind(camp, who, t),
      ]);
      return json({ ok: true, ts: t });
    }

    // -------- снапшоты отчётов OZON --------
    if (path === "/snapshot" && method === "POST") {
      const body = await request.json();
      const snap = body.snap;
      if (!snap || !snap.report_date) return err("snap.report_date обязателен");
      const data = JSON.stringify(snap);
      if (data.length > 1900000) return err("Снапшот слишком большой для одной строки D1 (>1.9 МБ)", 413);
      const who = author(request);
      await db.prepare(
        "INSERT INTO snapshots (report_date, data, author, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(report_date) DO UPDATE SET data=excluded.data, author=excluded.author, updated_at=excluded.updated_at"
      ).bind(String(snap.report_date), data, who, now()).run();
      return json({ ok: true });
    }
    if (path === "/snapshot" && method === "DELETE") {
      const date = String(url.searchParams.get("date") || "");
      if (!date) return err("date обязателен");
      await db.prepare("DELETE FROM snapshots WHERE report_date = ?").bind(date).run();
      return json({ ok: true });
    }
    if (path === "/snapshots" && method === "DELETE") {
      await db.prepare("DELETE FROM snapshots").run();
      return json({ ok: true });
    }

    // -------- универсальное KV (модуль «Индивидуальные условия») --------
    if (path === "/kv" && method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!key) return err("key обязателен");
      const row = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(key).first();
      let value = null;
      if (row && row.v != null) { try { value = JSON.parse(row.v); } catch (e) { value = null; } }
      return json({ ok: true, key, value });
    }
    if (path === "/kv" && method === "POST") {
      const body = await request.json();
      const key = String(body.key || "");
      if (!key) return err("key обязателен");
      const v = JSON.stringify(body.value != null ? body.value : null);
      if (v.length > 1900000) return err("Значение слишком большое для одной строки D1 (>1.9 МБ)", 413);
      await db.prepare("INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at")
        .bind(key, v, now()).run();
      return json({ ok: true });
    }

    // -------- заметки по товару: «Стратегия продвижения» и «Карта боли» --------
    // Хранятся одним ключом product_notes в таблице kv (server-side merge — без затирания).
    if (path === "/notes" && method === "GET") {
      const row = await db.prepare("SELECT v FROM kv WHERE k = 'product_notes'").first();
      let notes = {};
      if (row && row.v) { try { notes = JSON.parse(row.v); } catch (e) {} }
      return json({ ok: true, notes });
    }
    if (path === "/notes" && method === "POST") {
      const body = await request.json();
      const art = String(body.art || "").slice(0, 200);
      const kind = body.kind === "pain" ? "pain" : "strategy";
      if (!art) return err("art обязателен");
      const who = author(request);
      const t = now();
      const row = await db.prepare("SELECT v FROM kv WHERE k = 'product_notes'").first();
      let notes = {};
      if (row && row.v) { try { notes = JSON.parse(row.v); } catch (e) {} }
      notes[art] = notes[art] || {};
      notes[art][kind] = { text: String(body.text || "").slice(0, 6000), author: who, ts: t, ai: !!body.ai };
      const v = JSON.stringify(notes);
      if (v.length > 1900000) return err("Слишком много заметок для одной строки D1 (>1.9 МБ)", 413);
      await db.prepare("INSERT INTO kv (k, v, updated_at) VALUES ('product_notes', ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at")
        .bind(v, t).run();
      return json({ ok: true });
    }

    // -------- ИИ-анализ комментариев (Cloudflare Workers AI) --------
    if (path === "/ai" && method === "POST") {
      if (!env.AI) return err("Workers AI не подключён к проекту. Добавьте привязку 'AI' в Settings → Bindings.", 503);
      const body = await request.json();
      const kind = body.kind === "pain" ? "pain" : "strategy";
      const p = body.product || {};
      const comments = Array.isArray(body.comments) ? body.comments.slice(0, 120) : [];
      if (!comments.length) return err("Нет комментариев для анализа");
      const lines = [];
      lines.push("Товар: " + (p.name || p.art || "—") + (p.art ? " (арт. " + p.art + ")" : "") + (p.brand ? ", бренд " + p.brand : ""));
      if (p.metrics) lines.push("Текущие метрики: " + p.metrics);
      lines.push("", "История комментариев маркетологов (от старых к новым):");
      comments.forEach((c, i) => lines.push((i + 1) + ". [" + (c.author || "—") + (c.ts ? ", " + c.ts : "") + "] " + (c.text || "")));
      lines.push("", kind === "strategy"
        ? "Составь стратегию продвижения: что для товара работает и как это масштабировать."
        : "Составь карту боли: что для товара НЕ работает и чего делать нельзя.");
      const msgs = [
        { role: "system", content: kind === "strategy" ? SYS_STRATEGY : SYS_PAIN },
        { role: "user", content: lines.join("\n") },
      ];
      let lastErr = "";
      for (const model of AI_MODELS) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await env.AI.run(model, { messages: msgs, max_tokens: 700, temperature: 0.3 });
            let text = ((r && (r.response || r.result || r.text)) || "").toString();
            text = text.replace(/\*\*/g, "").replace(/(^|\s)\*(?=\S)/g, "$1").replace(/^#{1,6}\s*/gm, "").replace(/^\s*[-*•]\s+/gm, "— ").replace(/\n{3,}/g, "\n\n").trim();
            if (text) return json({ ok: true, text, model });
            lastErr = model + ": пустой ответ";
          } catch (e) {
            lastErr = model + ": " + ((e && e.message) ? e.message : String(e));
            // устаревшая/несуществующая модель — сразу к следующей, без повтора
            if (/deprecat|no such model|not found|5028|5007|invalid model/i.test(lastErr)) break;
            await new Promise((res) => setTimeout(res, 700));
          }
        }
      }
      return err("Ошибка Workers AI: " + lastErr, 502);
    }

    // -------- удаление дублей комментариев (одинаковый текст по одной РК в пределах 90с) --------
    if (path === "/dedup" && method === "POST") {
      async function findDupes(table, where) {
        const { results } = await db.prepare("SELECT id, camp_id, text, created_at FROM " + table + (where ? " WHERE " + where : "") + " ORDER BY camp_id, created_at, id").all();
        const del = []; const seen = {};
        for (const r of (results || [])) {
          const key = r.camp_id + "\u0000" + String(r.text || "").trim();
          const prev = seen[key];
          if (prev != null && (r.created_at - prev) < 90000) del.push(r.id);
          else seen[key] = r.created_at;
        }
        return del;
      }
      const delC = await findDupes("comments", "");
      const delE = await findDupes("events", "kind='comment'");
      for (const id of delC) await db.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
      for (const id of delE) await db.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
      return json({ ok: true, removed: delC.length });
    }

    return err("Неизвестный маршрут: " + method + " " + path, 404);
  } catch (e) {
    return err("Ошибка сервера: " + (e && e.message ? e.message : String(e)), 500);
  }
}
