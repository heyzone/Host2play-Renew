const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

/* ========================= CONFIG ========================= */
const RENEW_URL = process.env.RENEW_URL;
const HY2_URL = process.env.HY2_URL;
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || "51080", 10);
const MAX_RETRY = parseInt(process.env.MAX_RETRY || "3", 10);

const EXT_BUSTER = path.resolve(__dirname, "extensions/buster/unpacked");
const SCREEN_DIR = path.resolve(__dirname, "screenshots");

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

/* ========================= UTILS ========================= */
function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function maskIP(ip) {
  if (!ip) return "未知";
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : ip;
}

async function snap(page, name) {
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("📸 Screenshot:", file);
  } catch {}
}

/* ========================= UI CLEANER ========================= */
async function cleanUI(page) {
  try {
    await page.addStyleTag({
      content: `
        .fc-consent-root, .fc-dialog-overlay, iframe[src*="googleads"] { display: none !important; z-index: -1 !important; }
        body { overflow: auto !important; }
      `,
    });
  } catch {}
}

/* ========================= TELEGRAM ========================= */
async function sendTelegram(text) {
  try {
    if (!TELEGRAM_CHAT_ID || !TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) { console.log("⚠️ TG Error:", e.message); }
}

/* ========================= PROXY & IP ========================= */
async function startHy2() {
  if (!HY2_URL) throw new Error("❌ HY2_URL 未设置");
  const u = HY2_URL.replace("hysteria2://", "");
  const p = new URL("scheme://" + u);
  const cfgPath = path.join(os.tmpdir(), "hy2.json");

  fs.writeFileSync(cfgPath, JSON.stringify({
    server: `${p.hostname}:${p.port}`,
    auth: decodeURIComponent(p.username),
    tls: { sni: p.searchParams.get("sni") || p.hostname, insecure: p.searchParams.get("insecure") === "1" },
    socks5: { listen: `127.0.0.1:${SOCKS_PORT}` },
  }));

  const proc = spawn("hysteria", ["client", "-c", cfgPath]);
  const start = Date.now();
  while (Date.now() - start < 20000) {
    await sleep(1000);
    const ok = await new Promise(r => {
      const s = net.createConnection(SOCKS_PORT, "127.0.0.1");
      s.on("connect", () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (ok) return proc;
  }
  throw new Error("❌ 代理启动超时");
}

/* ========================= RENEW LOGIC ========================= */
async function renewOnce() {
  let hy2 = null, context = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  try {
    if (!fs.existsSync(path.join(EXT_BUSTER, "manifest.json"))) throw new Error("❌ Buster 插件路径错误");

    hy2 = await startHy2();
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [`--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`, `--disable-extensions-except=${EXT_BUSTER}`, `--load-extension=${EXT_BUSTER}`, "--no-sandbox"]
    });

    const page = await context.newPage();
    console.log("🔗 访问页面...");
    await page.goto(RENEW_URL, { waitUntil: "networkidle", timeout: 60000 });
    await cleanUI(page);

    const getInfo = async () => {
      const d = await page.locator("#deleteDate").textContent().catch(() => "");
      return d.trim();
    };
    const beforeDate = await getInfo();
    console.log(`📊 续期前删除时间: ${beforeDate}`);

    console.log("🔘 点击 Renew 按钮");
    await page.click('button:has-text("Renew server")', { force: true });

    // ⭐ 修复：等待弹窗，并处理可能被判定为 hidden 的 iframe
    console.log("⏳ 等待验证码弹窗...");
    await page.waitForSelector('.swal2-popup', { state: 'visible', timeout: 20000 });
    await sleep(2000); // 确保动画完成

    // ⭐ 修复：强制定位 recaptcha 框，不管它是否被判定为可见
    const anchorFrame = page.frameLocator('iframe[src*="api2/anchor"]').first();
    const checkbox = anchorFrame.locator('#recaptcha-anchor');
    
    console.log("☑️ 尝试点击验证码复选框...");
    await checkbox.click({ force: true, timeout: 15000 });

    console.log("🧩 等待 Buster 插件处理 (15s)...");
    await sleep(15000); 
    await snap(page, "after_captcha_wait");

    console.log("🚀 点击确认提交");
    const confirmBtn = page.locator(".swal2-confirm");
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click({ force: true });
    }

    await sleep(5000);
    await page.reload({ waitUntil: "networkidle" });
    const afterDate = await getInfo();
    console.log(`📊 续期后删除时间: ${afterDate}`);

    if (afterDate && afterDate !== beforeDate) {
      return { ok: true, before: beforeDate, after: afterDate };
    }
    throw new Error("数据未变化，续期可能未成功");

  } catch (e) {
    console.error("💥 运行报错:", e.message);
    await snap(page, "error_trace");
    return { ok: false, error: e.message };
  } finally {
    if (context) await context.close();
    if (hy2) hy2.kill();
  }
}

/* ========================= RUN ========================= */
(async () => {
  let res = null;
  for (let i = 1; i <= MAX_RETRY; i++) {
    console.log(`\n--- 尝试进度: ${i}/${MAX_RETRY} ---`);
    res = await renewOnce();
    if (res.ok) break;
    await sleep(5000);
  }

  if (res.ok) {
    await sendTelegram(`✅ <b>Host2Play 续期成功</b>\n🗑 删除时间更新为: <code>${res.after}</code>`);
    process.exit(0);
  } else {
    await sendTelegram(`❌ <b>Host2Play 续期失败</b>\n原因: <code>${res.error}</code>`);
    process.exit(1);
  }
})();
