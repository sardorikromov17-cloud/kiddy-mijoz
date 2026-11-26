// Sinxronlashning qo'shimcha qadamlari:
// oldi-berdi hujjatlari, buyurtma holatlari, "kelganda xabar ber", yangi tovarlar, qarz eslatmasi.
import { db, getState, setState } from "./db.ts";
import { iboxPaged, timeUp } from "./ibox.ts";
import { getSettings } from "./settings.ts";
import { esc, fmt, notifyClient } from "./notify.ts";
import { clientLedger } from "./ledger.ts";

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const sumOf = (arr: unknown, key: string) =>
  Array.isArray(arr) ? arr.reduce((s: number, x: any) => s + (num(x?.[key]) ?? 0), 0) : null;
const utc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** "2026-11-25T19:14:23Z" (UTC) yoki "2026-11-25" → Toshkent bo'yicha sana YYYY-MM-DD */
export function tashkentDate(v: unknown): string {
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s.includes("T") || /[+Z]/.test(s) ? s : s.replace(" ", "T") + "+05:00");
  if (!Number.isFinite(t)) return s.slice(0, 10);
  return new Date(t + 5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Hujjat ro'yxatlari javobining shakli iBox hujjatida ko'rsatilmagan ("data": {}).
 * Keng tarqalgan maydon nomlarini tekshiramiz; birinchi qator sync_state'ga namuna sifatida yoziladi.
 */
export function mapDoc(r: any) {
  const id = num(r.id);
  const clientId = num(r.outlet_id ?? r.outlet?.id ?? r.client_id ?? r.client?.id ?? r.counterparty_outlet_id);
  const date = tashkentDate(r.date ?? r.document_date ?? r.doc_date ?? r.created_at);
  const currency = String(r.currency_code ?? r.currency?.code ?? (r.currency_id == 2 ? "USD" : "UZS")).toUpperCase() === "USD" ? "USD" : "UZS";
  const amount = num(r.total ?? r.total_sum ?? r.amount ?? r.sum)
    ?? sumOf(r.payment_details, "amount") ?? sumOf(r.shipment_details, "total") ?? sumOf(r.details, "total");
  const status = num(r.status?.id ?? r.status);
  const parent = num(r.parent_id ?? r.order_id ?? r.parent?.id);
  if (id === null || clientId === null || !/^\d{4}-\d{2}-\d{2}$/.test(date) || amount === null) return null;
  return { id, clientId, date, currency, amount: Math.abs(amount), status, number: r.number != null ? String(r.number) : null, parent, comment: r.comment ?? null };
}

// Qaysi holatdagi hujjat qarzga ta'sir qiladi (Kiddy Toys iBox'ida tekshirilgan):
//  sotuv:   21 qoralama ✗, 22 yangi ✓, 23 yuborilgan ✓, 24 yakunlangan ✓
//  to'lov:  71 qoralama ✗, 72 kutilmoqda ✗, 73 yakunlangan ✓
//  qaytish: 31 qoralama ✗, 32 kutilmoqda ✗, 33 qabul qilingan ✓
const COUNTS: Record<string, (s: number) => boolean> = {
  shipment: (s) => s >= 22 && s <= 24,
  payment: (s) => s === 73,
  return: (s) => s === 33,
};
const counts = (kind: string, status: number | null) => status === null || (COUNTS[kind]?.(status) ?? true);

const DOCS = [
  { kind: "shipment", path: "document/shipment/list", sign: 1 },
  { kind: "payment", path: "document/payment-received/list", sign: -1 },
  { kind: "return", path: "document/return/list", sign: -1 },
] as const;

export async function syncLedger(full = false): Promise<number> {
  const sql = db();
  const lastTo = full ? null : await getState("ledger_synced_to");
  let from: Date;
  if (lastTo) from = new Date(Date.parse(lastTo) - 3 * 86400_000); // 3 kun ustma-ust: kechikib kiritilgan hujjatlar uchun
  else {
    const [r] = await sql`select min(opening_balance_date) as d from mijoz.clients`;
    from = r?.d ? new Date(r.d) : new Date(Date.now() - 365 * 86400_000);
  }
  const end = new Date();
  let count = 0;
  // Oyma-oy yuklaymiz; vaqt tugasa — shu joygacha saqlab, keyingi chaqiruvda davom etadi
  while (from < end) {
    const to = new Date(Math.min(end.getTime(), from.getTime() + 31 * 86400_000));
    for (const d of DOCS) {
      let sampled = false;
      for await (const { rows } of iboxPaged(d.path, { "period[from]": utc(from), "period[to]": utc(to) }, 100)) {
        if (!sampled && rows[0]) { await setState(`sample_${d.kind}`, JSON.stringify(rows[0]).slice(0, 4000)); sampled = true; }
        const mapped = rows.map(mapDoc).filter((x): x is NonNullable<ReturnType<typeof mapDoc>> => !!x);
        if (!mapped.length) continue;
        const data = mapped.map((m) => ({
          id: `${d.kind}:${m.id}`, client_id: m.clientId, doc_date: m.date, kind: d.kind, currency: m.currency,
          amount: counts(d.kind, m.status) ? d.sign * m.amount : 0, doc_number: m.number, ibox_status: m.status,
          comment: m.comment ? String(m.comment).slice(0, 300) : null, parent_ibox_id: m.parent,
        }));
        await sql`
          insert into mijoz.ledger ${sql(data, "id", "client_id", "doc_date", "kind", "currency", "amount", "doc_number", "ibox_status", "comment", "parent_ibox_id")}
          on conflict (id) do update set client_id = excluded.client_id, doc_date = excluded.doc_date, amount = excluded.amount, currency = excluded.currency,
            doc_number = excluded.doc_number, ibox_status = excluded.ibox_status, comment = excluded.comment,
            parent_ibox_id = excluded.parent_ibox_id, synced_at = now()`;
        count += data.length;
      }
    }
    await setState("ledger_synced_to", to.toISOString());
    from = to;
    if (timeUp()) break;
  }
  return count;
}

const STATUS_MSG: Record<string, (no: number) => string> = {
  accepted: (no) => `✅ Buyurtma <b>№${no}</b> tasdiqlandi. Tez orada yig'ib jo'natamiz.`,
  shipped: (no) => `📦 Buyurtma <b>№${no}</b> yig'ildi va jo'natishga tayyor.`,
  cancelled: (no) => `❌ Buyurtma <b>№${no}</b> bekor qilindi. Savollar bo'lsa, ilovadagi chat orqali yozing.`,
};

/** iBox'dagi buyurtma holatini olib, o'zgargan bo'lsa mijozga xabar beradi */
export async function syncOrderStatuses(): Promise<number> {
  const sql = db();
  const open = await sql`
    select id, no, client_id, status, ibox_id, created_at from mijoz.orders
    where ibox_id is not null and status in ('sent','accepted','shipped') and created_at > now() - interval '45 days'`;
  if (!open.length) return 0;
  const byIbox = new Map(open.map((o: any) => [Number(o.ibox_id), o]));
  const from = new Date(Math.min(...open.map((o: any) => new Date(o.created_at).getTime())) - 86400_000);
  const iboxStatus = new Map<number, number>();
  let sampled = false;
  for await (const { rows } of iboxPaged("document/order/list", { "period[from]": utc(from), "period[to]": utc(new Date()) }, 100)) {
    if (!sampled && rows[0]) { await setState("sample_order", JSON.stringify(rows[0]).slice(0, 4000)); sampled = true; }
    for (const r of rows) {
      const id = num(r.id), st = num(r.status?.id ?? r.status);
      if (id !== null && st !== null && byIbox.has(id)) iboxStatus.set(id, st);
    }
  }
  // Buyurtmadan yaratilgan jo'natmalar (oldi-berdi sinxronlashidan)
  const shippedRows = await sql`
    select distinct parent_ibox_id from mijoz.ledger
    where kind = 'shipment' and amount > 0 and parent_ibox_id = any(${[...byIbox.keys()]}::bigint[])`;
  const shipped = new Set(shippedRows.map((r: any) => Number(r.parent_ibox_id)));

  let changed = 0;
  for (const [iboxId, o] of byIbox) {
    const st = iboxStatus.get(iboxId);
    let next = o.status as string;
    if (st === 44) next = "cancelled";
    else if (shipped.has(iboxId)) next = "shipped";
    else if (st === 43) next = "accepted";
    if (next === o.status) continue;
    await sql`update mijoz.orders set status = ${next}, ibox_status = ${st ?? null}, status_changed_at = now() where id = ${o.id}`;
    const msg = STATUS_MSG[next];
    if (msg && await notifyClient(Number(o.client_id), msg(Number(o.no)), { text: "Buyurtmani ko'rish", path: `/buyurtma/${o.id}` })) {
      await sql`update mijoz.orders set notified_status = ${next} where id = ${o.id}`;
    }
    changed++;
  }
  return changed;
}

/** "Kelganda xabar ber": tovar omborga qaytganda mijozlarga xabar */
export async function stockAlerts(): Promise<number> {
  const sql = db();
  const due = await sql`
    select a.client_id, a.product_id, p.name, p.price::float8 as price from mijoz.stock_alerts a
    join mijoz.products p on p.id = a.product_id
    where a.notified_at is null and p.active and coalesce(p.stock, 0) > 0 limit 200`;
  let sent = 0;
  for (const a of due) {
    await notifyClient(Number(a.client_id),
      `🔔 Siz kutgan tovar omborga keldi!\n<b>${esc(a.name)}</b>${a.price ? `\nNarxi: ${fmt(a.price)} so'm` : ""}`,
      { text: "Buyurtma berish", path: `/tovar/${a.product_id}` });
    await sql`update mijoz.stock_alerts set notified_at = now() where client_id = ${a.client_id} and product_id = ${a.product_id}`;
    sent++;
  }
  await sql`delete from mijoz.stock_alerts where notified_at < now() - interval '30 days'`;
  return sent;
}

/** Yangi kelgan tovarlar haqida kuniga bir marta xabar (09:00–20:00 Toshkent) */
export async function newArrivals(): Promise<number> {
  const sql = db();
  // Birinchi ishga tushishda mavjud tovarlarning hammasini "eski" deb belgilaymiz — minglab xabar ketmasin
  if (!(await getState("catalog_baseline"))) {
    await sql`update mijoz.products set announced_at = now() where announced_at is null`;
    await setState("catalog_baseline", new Date().toISOString());
    return 0;
  }
  const s = await getSettings();
  if (!s.new_arrivals_notify) return 0;
  const hour = (new Date().getUTCHours() + 5) % 24;
  if (hour < 9 || hour >= 20) return 0;
  const last = await getState("news_sent_at");
  if (last && Date.now() - Date.parse(last) < 20 * 3600_000) return 0;

  const fresh = await sql`
    select id, name, price::float8 as price from mijoz.products
    where announced_at is null and active and coalesce(stock, 0) > 0 and price > 0
    order by first_seen_at desc limit 30`;
  if (!fresh.length) return 0;
  const list = fresh.slice(0, 8).map((p: any) => `• ${esc(p.name)} — ${fmt(p.price)} so'm`).join("\n");
  const more = fresh.length > 8 ? `\n…va yana ${fresh.length - 8} ta` : "";
  const html = `🆕 <b>Yangi tovarlar keldi!</b>\n\n${list}${more}`;
  const clients = await sql`
    select distinct on (tg_chat_id) id from mijoz.clients
    where tg_chat_id is not null and active and notify_news order by tg_chat_id, id`;
  let sent = 0;
  for (const c of clients) {
    if (await notifyClient(Number(c.id), html, { text: "Yangi tovarlarni ko'rish", path: "/katalog?sort=new" })) sent++;
    await new Promise((r) => setTimeout(r, 40)); // Telegram cheklovi: sekundiga ~30 xabar
  }
  await sql`update mijoz.products set announced_at = now() where id = any(${fresh.map((p: any) => p.id)}::bigint[])`;
  await setState("news_sent_at", new Date().toISOString());
  return sent;
}

/** Muddati o'tgan qarz haqida haftada bir eslatma */
export async function overdueReminders(): Promise<number> {
  const s = await getSettings();
  if (!s.ledger_enabled || !s.overdue_reminder) return 0;
  const hour = (new Date().getUTCHours() + 5) % 24;
  if (hour < 10 || hour >= 18) return 0;
  const sql = db();
  const candidates = await sql`
    select c.id from mijoz.clients c join mijoz.client_balance b on b.client_id = c.id
    where c.tg_chat_id is not null and c.active and c.credit_days is not null and b.balance > 0
      and (c.overdue_notified_at is null or c.overdue_notified_at < now() - interval '7 days')
    limit 40`;
  let sent = 0;
  for (const c of candidates) {
    const l = await clientLedger(Number(c.id));
    await sql`update mijoz.clients set overdue_notified_at = now() where id = ${c.id}`;
    if (!l || l.overdue <= 0) continue;
    if (await notifyClient(Number(c.id),
      `⏰ Eslatma: <b>${fmt(l.overdue)} so'm</b> qarzning to'lov muddati o'tgan.\nUmumiy qarz: ${fmt(l.debt)} so'm.`,
      { text: "Oldi-berdini ko'rish", path: "/kabinet?tab=ledger" })) sent++;
  }
  return sent;
}
