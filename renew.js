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

// 路径必须与 yml 中的 mkdir 保持一致
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
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("📸 Screenshot:", file);
  } catch {}
}

/* ========================= HY2 PROXY ========================= */
async function startHy2() {
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

/* ========================= RENEW FLOW ========================= */
async function renewOnce() {
  let hy2 = null, context = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  try {
    // 检查扩展是否存在
    if (!fs.existsSync(path.join(EXT_NOPECHA, "manifest.json"))) {
      throw new Error(`❌ NopeCHA 扩展未找到，请检查 yml 下载路径: ${EXT_NOPECHA}`);
    }

    hy2 = await startHy2();

    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
        `--disable-extensions-except=${EXT_NOPECHA}`,
        `--load-extension=${EXT_NOPECHA}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    console.log("🌍 访问 Host2Play...");
    await page.goto(RENEW_URL, { waitUntil: "networkidle" });
    
    const before = (await page.locator("#deleteDate").textContent().catch(() => "")).trim();
    console.log(`📊 续期前: ${before}`);

    console.log("🔘 点击 Renew 按钮");
    await page.click('button:has-text("Renew server")', { force: true });

    // 等待弹窗和验证码出现
    console.log("⏳ 等待验证码弹窗...");
    await page.waitForSelector('.swal2-popup', { state: 'visible' });
    
    // NopeCHA 会自动识别并填充，我们只需要等待勾选出现
    console.log("🧩 等待 NopeCHA 完成自动识别...");
    const anchorFrame = page.frameLocator('iframe[src*="api2/anchor"]').first();
    const checkbox = anchorFrame.locator('#recaptcha-anchor');
    
    // 点击一次勾选框触发 NopeCHA
    await checkbox.click({ force: true }).catch(() => {});

    // 关键：循环检测 Token 是否已生成（name="g-recaptcha-response" 的 textarea）
    let solved = false;
    for (let i = 0; i < 30; i++) { // 最多等 60 秒
        const token = await page.evaluate(() => {
            return document.querySelector('textarea[name="g-recaptcha-response"]')?.value;
        });
        if (token && token.length > 50) {
            console.log("✅ 验证码已破译 (Token Ready)");
            solved = true;
            break;
        }
        await sleep(2000);
    }

    if (!solved) throw new Error("❌ NopeCHA 破译超时");

    await snap(page, "captcha_solved");

    console.log("🚀 提交最终确认");
    await page.click(".swal2-confirm", { force: true });

    await sleep(5000);
    await page.reload({ waitUntil: "networkidle" });
    const after = (await page.locator("#deleteDate").textContent().catch(() => "")).trim();
    console.log(`📊 续期后: ${after}`);

    if (after !== before) return { ok: true, before, after };
    throw new Error("数据未变化");

  } catch (e) {
    console.error("💥 报错:", e.message);
    await snap(page, "error");
    return { ok: false, error: e.message };
  } finally {
    if (context) await context.close();
    if (hy2) hy2.kill();
  }
}

/* ========================= ENTRY ========================= */
(async () => {
  let finalRes = null;
  for (let i = 1; i <= MAX_RETRY; i++) {
    console.log(`\n--- 尝试 ${i}/${MAX_RETRY} ---`);
    finalRes = await renewOnce();
    if (finalRes.ok) break;
    await sleep(5000);
  }

  const tgUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const msg = finalRes.ok 
    ? `✅ <b>Host2Play 成功</b>\n旧: ${finalRes.before}\n新: ${finalRes.after}`
    : `❌ <b>Host2Play 失败</b>\n原因: ${finalRes.error}`;

  if (TELEGRAM_BOT_TOKEN) {
    await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
    });
  }
  process.exit(finalRes.ok ? 0 : 1);
})();
