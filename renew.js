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

const EXT_NOPECHA = path.resolve(__dirname, "extensions/nopecha/unpacked");
const SCREEN_DIR = path.resolve(__dirname, "screenshots");

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

/* ========================= UTILS ========================= */
function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function snap(page, name) {
  if (!page) return; // 🛡️ 防止 page 未定义时报错
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("📸 Screenshot:", file);
  } catch (e) { console.log("⚠️ Snap error:", e.message); }
}

/* ========================= HY2 PROXY ========================= */
async function startHy2() {
  if (!HY2_URL) throw new Error("❌ HY2_URL Secret 未设置");
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
  
  // 增加代理可用性检测
  const start = Date.now();
  while (Date.now() - start < 20000) {
    await sleep(2000);
    const ok = await new Promise(r => {
      const s = net.createConnection(SOCKS_PORT, "127.0.0.1");
      s.on("connect", () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (ok) return proc;
  }
  proc.kill();
  throw new Error("❌ Hysteria2 代理无法连接");
}

/* ========================= RENEW FLOW ========================= */
async function renewOnce() {
  let hy2 = null, context = null, page = null; // 🛡️ 预定义 page 为 null
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  try {
    if (!fs.existsSync(path.join(EXT_NOPECHA, "manifest.json"))) {
      throw new Error(`❌ NopeCHA 扩展未找到: ${EXT_NOPECHA}`);
    }

    hy2 = await startHy2();
    console.log("✅ 代理已启动，正在启动浏览器...");

    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
        `--disable-extensions-except=${EXT_NOPECHA}`,
        `--load-extension=${EXT_NOPECHA}`,
        "--no-sandbox",
      ],
    });

    page = await context.newPage();
    page.setDefaultTimeout(90000); // 增加到 90 秒

    console.log("🌍 正在访问 Host2Play (domcontentloaded 模式)...");
    // 🛡️ 使用 domcontentloaded 避免因为广告没加载完而超时
    await page.goto(RENEW_URL, { waitUntil: "domcontentloaded" });
    await sleep(5000); // 给页面一点时间缓冲

    const before = (await page.locator("#deleteDate").textContent().catch(() => "未知")).trim();
    console.log(`📊 续期前: ${before}`);

    console.log("🔘 点击 Renew 按钮");
    await page.click('button:has-text("Renew server")', { force: true });

    console.log("⏳ 等待弹窗并处理验证码...");
    await page.waitForSelector('.swal2-popup', { state: 'visible' });
    
    // NopeCHA 自动识别
    await sleep(15000); 
    await snap(page, "nopecha_processing");

    // 检测是否有验证码 token 生成
    const isSolved = await page.evaluate(() => {
        const t = document.querySelector('textarea[name="g-recaptcha-response"]');
        return t && t.value.length > 50;
    });

    if (isSolved) {
        console.log("✅ NopeCHA 似乎已完成识别，准备提交");
    } else {
        console.log("⚠️ 未检测到 Token，尝试点击一次确认看看...");
    }

    await page.click(".swal2-confirm", { force: true });
    await sleep(8000);

    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(5000);
    const after = (await page.locator("#deleteDate").textContent().catch(() => "获取失败")).trim();
    console.log(`📊 续期后: ${after}`);

    if (after !== before && after !== "获取失败") return { ok: true, before, after };
    throw new Error("续期后日期未更新，请检查截图");

  } catch (e) {
    console.error("💥 错误详情:", e.message);
    if (page) await snap(page, "error"); // 🛡️ 只有 page 存在时才截图
    return { ok: false, error: e.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (hy2) hy2.kill();
  }
}

/* ========================= ENTRY ========================= */
(async () => {
  let finalRes = { ok: false };
  for (let i = 1; i <= MAX_RETRY; i++) {
    console.log(`\n--- 尝试第 ${i}/${MAX_RETRY} 次 ---`);
    finalRes = await renewOnce();
    if (finalRes.ok) break;
    await sleep(5000);
  }

  const msg = finalRes.ok 
    ? `✅ <b>Host2Play 续期成功</b>\n旧日期: ${finalRes.before}\n新日期: ${finalRes.after}`
    : `❌ <b>Host2Play 续期失败</b>\n原因: ${finalRes.error}`;

  if (TELEGRAM_BOT_TOKEN) {
    const tgUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
    }).catch(() => {});
  }
  process.exit(finalRes.ok ? 0 : 1);
})();
