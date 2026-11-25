// GitHub Actions ichida ishlaydi: serverni (Supabase) to'liq o'rnatadi yoki yangilaydi.
// Kerakli maxfiy qiymatlar (GitHub → Settings → Secrets → Actions):
//   SUPABASE_ACCESS_TOKEN, IBOX_TOKEN, TELEGRAM_BOT_TOKEN
// Oddiy sozlamalar .github/workflows/ornatish.yml ichidagi env: bo'limida.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, unlinkSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E = process.env;
const need = (k) => { const v = (E[k] || "").trim(); if (!v) fail(`${k} berilmagan (GitHub → Settings → Secrets and variables → Actions)`); return v; };
function fail(msg) { console.log(`::error::${msg}`); process.exit(1); }
const step = (t) => console.log(`\n=== ${t}`);
const ok = (t) => console.log(`  ✓ ${t}`);
const warn = (t) => console.log(`::warning::${t}`);
const mask = (v) => v && console.log(`::add-mask::${v}`);

const ACCESS = need("SUPABASE_ACCESS_TOKEN");
const REF = need("SUPABASE_PROJECT_REF");
const IBOX_TOKEN = need("IBOX_TOKEN");
const TG = need("TELEGRAM_BOT_TOKEN");
const ADMIN_PHONE = need("ADMIN_PHONE");
const ADMIN_NAME = E.ADMIN_NAME || "Admin";
const OWNER = (E.GITHUB_REPOSITORY || "x/kiddy-mijoz").split("/")[0].toLowerCase();
const REPO = (E.GITHUB_REPOSITORY || "x/kiddy-mijoz").split("/")[1];
const APP_URL = `https://${OWNER}.github.io/${REPO}/`;
const API_BASE = `https://${REF}.supabase.co/functions/v1`;
const IBOX = {
  base: E.IBOX_BASE_URL || "https://kiddytoys.ibox.io",
  filial: E.IBOX_FILIAL_ID || "10", price: E.IBOX_PRICE_TYPE_ID || "1",
  warehouse: E.IBOX_WAREHOUSE_ID || "12", currency: E.IBOX_CURRENCY_ID || "1", reserve: E.IBOX_RESERVE || "false",
};
// Ichki maxfiy kalitlar Supabase tokenidan barqaror tarzda hosil qilinadi (har safar bir xil)
const derive = (label, len = 40) => createHmac("sha256", ACCESS).update(`kiddy:${REF}:${label}`).digest("hex").slice(0, len);
const SYNC_SECRET = derive("sync"), WH_SECRET = derive("tg-webhook", 32);
[ACCESS, IBOX_TOKEN, TG, SYNC_SECRET, WH_SECRET].forEach(mask);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mgmt(method, path, body) {
  const res = await fetch(`https://api.supabase.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  if (!res.ok) throw new Error(`Supabase API ${res.status}: ${typeof j === "string" ? j.slice(0, 400) : JSON.stringify(j).slice(0, 400)}`);
  return j;
}
const sqlq = (query) => mgmt("POST", `/projects/${REF}/database/query`, { query });
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
function supa(args) {
  const r = spawnSync("supabase", args, { cwd: ROOT, stdio: "inherit", env: { ...E, SUPABASE_ACCESS_TOKEN: ACCESS } });
  return r.status === 0;
}

// 1 -----------------------------------------------------------------
step("Tekshiruv: Supabase loyihasi, iBox, Telegram");
const proj = await mgmt("GET", `/projects/${REF}`).catch((e) => fail(`Supabase loyihasi topilmadi (${REF}): ${e.message}`));
ok(`Supabase: ${proj.name} (${proj.region}), holati ${proj.status}`);
if (proj.status !== "ACTIVE_HEALTHY") {
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    const p = await mgmt("GET", `/projects/${REF}`);
    if (p.status === "ACTIVE_HEALTHY") { ok("Loyiha tayyor"); break; }
    if (i === 29) fail(`Loyiha hali tayyor emas: ${p.status}`);
  }
}
{
  const r = await fetch(`${IBOX.base}/api/integration/product/list?limit=1`, {
    headers: { Authorization: `Bearer ${IBOX_TOKEN}`, "Filial-Id": IBOX.filial, Accept: "application/json" },
  });
  if (!r.ok) fail(`iBox kaliti ishlamadi (HTTP ${r.status}). IBOX_TOKEN ni tekshiring.`);
  ok("iBox kaliti ishlayapti");
}
const me = await tg("getMe").catch((e) => fail(`Telegram bot tokeni ishlamadi: ${e.message}`));
ok(`Telegram bot: @${me.username}`);
// Bot boshqa joyga ulangan bo'lsa (masalan boshqa loyiha boti) — buzmaslik uchun to'xtaymiz
{
  const wi = await tg("getWebhookInfo");
  const mine = `${API_BASE}/tg-bot`;
  if (wi.url && wi.url !== mine && E.TG_BOT_TAKEOVER !== "1") {
    fail(`@${me.username} boshqa serverga ulangan (${wi.url}). Bu bot boshqa loyihada ishlatilayotgan bo'lishi mumkin — mijozlar ilovasi uchun alohida bot oching va TELEGRAM_BOT_TOKEN ni almashtiring.`);
  }
}

// 2 -----------------------------------------------------------------
step("Ma'lumotlar bazasi (migratsiyalar)");
await sqlq(`create schema if not exists kiddy_meta;
  create table if not exists kiddy_meta.migrations (name text primary key, applied_at timestamptz not null default now());`);
const done = new Set((await sqlq(`select name from kiddy_meta.migrations`)).map((r) => r.name));
const dir = join(ROOT, "supabase", "migrations");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  if (done.has(f)) { ok(`${f} — avval bajarilgan`); continue; }
  const sql = readFileSync(join(dir, f), "utf8");
  await sqlq(sql).catch((e) => fail(`${f}: ${e.message}`));
  await sqlq(`insert into kiddy_meta.migrations (name) values ('${f.replace(/'/g, "''")}') on conflict do nothing`);
  ok(`${f} — bajarildi`);
}

// 3 -----------------------------------------------------------------
step("Server sozlamalari (Edge Function secrets)");
const env = {
  IBOX_BASE_URL: IBOX.base, IBOX_TOKEN, IBOX_FILIAL_ID: IBOX.filial, IBOX_PRICE_TYPE_ID: IBOX.price,
  IBOX_WAREHOUSE_ID: IBOX.warehouse, IBOX_CURRENCY_ID: IBOX.currency, IBOX_RESERVE: IBOX.reserve,
  SYNC_SECRET, TELEGRAM_BOT_TOKEN: TG, TELEGRAM_BOT_USERNAME: me.username, TELEGRAM_WEBHOOK_SECRET: WH_SECRET,
  MANAGER_PHONE: E.MANAGER_PHONE || ADMIN_PHONE, MANAGER_CHAT_ID: E.MANAGER_CHAT_ID || "",
  ALLOWED_ORIGINS: `https://${OWNER}.github.io`, APP_URL,
};
await mgmt("POST", `/projects/${REF}/secrets`,
  Object.entries(env).filter(([, v]) => v !== "").map(([name, value]) => ({ name, value: String(value) })));
ok("Sozlamalar yozildi");

// 4 -----------------------------------------------------------------
step("Server funksiyalari");
if (!supa(["functions", "deploy", "api", "ibox-sync", "tg-bot", "admin", "--no-verify-jwt", "--use-api", "--yes", "--project-ref", REF])) {
  fail("Funksiyalarni yuklab bo'lmadi");
}
ok("api, ibox-sync, tg-bot, admin yuklandi");
await sleep(8000);

// 5 -----------------------------------------------------------------
step("Telegram bot");
await tg("setWebhook", { url: `${API_BASE}/tg-bot`, secret_token: WH_SECRET, allowed_updates: ["message"], drop_pending_updates: true });
await tg("setMyCommands", { commands: [{ command: "start", description: "Raqamni ulash" }] }).catch(() => {});
ok(`@${me.username} serverga ulandi`);

// 6 -----------------------------------------------------------------
step("Admin, avtomatik sinxronlash, birinchi yuklash");
async function sync(body) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${API_BASE}/ibox-sync`, {
      method: "POST", headers: { Authorization: `Bearer ${SYNC_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(170000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ message: e.message }) }));
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    warn(`ibox-sync: ${r.status} ${j.message || j.error || ""} — qayta urinamiz`);
    await sleep(8000);
  }
  fail("ibox-sync javob bermadi");
}
const s = await sync({ setup: { admin_phone: ADMIN_PHONE, admin_name: ADMIN_NAME, cron_url: `${API_BASE}/ibox-sync` } });
ok(`Admin: ${s.admin}; har 5 daqiqalik sinxronlash: ${s.cron}`);
// Katta birinchi yuklash bo'laklarga bo'linadi — tugaguncha qayta chaqiramiz
for (let round = 1; round <= 15; round++) {
  const r = await sync({ budget_ms: 110000 });
  const parts = Object.entries(r).map(([k, v]) => `${k}: ${v.skipped ? "keyingi bo'lakda" : v.ok ? v.count : "XATO " + v.error}`);
  console.log(`  ${round}-bo'lak → ${parts.join(" · ")}`);
  const pending = Object.values(r).some((v) => v.skipped);
  const [{ c, p }] = await sqlq(`select (select value from mijoz.sync_state where key='clients_cursor') c,
                                       (select value from mijoz.sync_state where key='products_cursor') p`).catch(() => [{}]);
  if (!pending && !c && !p) { ok("Birinchi yuklash tugadi"); break; }
}
const [stat] = await sqlq(`select (select count(*) from mijoz.products where active) products,
  (select count(*) from mijoz.clients where active) clients, (select count(*) from mijoz.ledger) docs`);
ok(`Bazada: ${stat.products} tovar, ${stat.clients} mijoz, ${stat.docs} hujjat`);

// 7 -----------------------------------------------------------------
step("Ilova sozlamasi (web/config.js)");
const cfgPath = join(ROOT, "web", "config.js");
let cfg = readFileSync(cfgPath, "utf8");
cfg = cfg.replace(/API_URL:\s*"[^"]*"/, `API_URL: "${API_BASE}/api"`)
  .replace(/ANDROID_APK_URL:\s*"[^"]*"/, `ANDROID_APK_URL: "https://github.com/${E.GITHUB_REPOSITORY}/releases/latest/download/kiddy-toys.apk"`);
writeFileSync(cfgPath, cfg);
const sw = join(ROOT, "web", "sw.js");
writeFileSync(sw, readFileSync(sw, "utf8").replace(/const VERSION = "kt-v?[0-9]*"/, `const VERSION = "kt-${E.GITHUB_RUN_NUMBER || Date.now()}"`));
ok(`Ilova: ${APP_URL}  ·  Admin panel: ${APP_URL}admin/`);
if (E.GITHUB_STEP_SUMMARY) {
  appendFileSync(E.GITHUB_STEP_SUMMARY, `### Kiddy Toys mijozlar ilovasi\n\n- Ilova: ${APP_URL}\n- Admin panel: ${APP_URL}admin/ (telefon: ${ADMIN_PHONE})\n- Telegram bot: https://t.me/${me.username}\n- Bazada: ${stat.products} tovar, ${stat.clients} mijoz\n`);
}
