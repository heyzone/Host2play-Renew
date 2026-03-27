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

// ⭐ 路径对齐
const EXT_PATH = path.resolve(__dirname, "extensions/buster/unpacked");
const SCREEN_DIR = path.resolve(__dirname, "screenshots");

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

/* ========================= UTILS ========================= */
function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function snap(page, name) {
  if (!page) return;
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("📸 Screenshot:", file);
  } catch {}
}

/* ========================= ⭐ UI 强力净化 (关键修改) ========================= */
async function cleanUI(page) {
    try {
        // 强行注入 CSS，隐藏干扰弹窗、遮罩层和那个死慢的 Translate 广告
        await page.addStyleTag({
            content: `
                .fc-consent-root, 
                .fc-dialog-overlay, 
                div[class*="translate"], 
                iframe[src*="googleads"],
                iframe[src*="doubleclick"] { 
                    display: none !important; 
                    z-index: -1 !important; 
                    visibility: hidden !important;
                }
                body { overflow: auto !important; }
            `
        });
        // 额外尝试移除那个乌克兰语广告容器
        await page.evaluate(() => {
            document.querySelectorAll('div[class*="goog-te-banner-frame"]').forEach(e => e.remove());
        }).catch(() => {});
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
    await sleep(2000);
    const ok = await new Promise(r => {
      const s = net.createConnection(SOCKS_PORT, "127.0.0.1");
      s.on("connect", () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (ok) return proc;
  }
  proc.kill();
  throw new Error("❌ 代理连接失败");
}

/* ========================= RENEW FLOW ========================= */
async function renewOnce() {
  let hy2 = null, context = null, page = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  try {
    if (!fs.existsSync(path.join(EXT_PATH, "manifest.json"))) throw new Error(`❌ 插件未找到: ${EXT_PATH}`);

    hy2 = await startHy2();
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      args: [
        `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        "--no-sandbox",
      ],
    });

    page = await context.newPage();
    page.setDefaultTimeout(60000);

    console.log("🌍 访问页面...");
    // 🛡️ 使用 domcontentloaded 加快加载，避免死等广告
    await page.goto(RENEW_URL, { waitUntil: "domcontentloaded" });
    await sleep(5000); 
    await cleanUI(page); // 强力净化 UI

    const before = (await page.locator("#deleteDate").textContent().catch(() => "未知")).trim();
    console.log(`📊 续期前: ${before}`);

    console.log("🔘 点击 Renew 按钮");
    // 使用 force: true 强点击，不管有没有被干扰遮挡
    await page.click('button:has-text("Renew server")', { force: true });

    // ⭐ 处理弹窗动画和 hidden iframe 报错
    console.log("⏳ 等待验证码弹窗...");
    await page.waitForSelector('.swal2-popup', { state: 'attached', timeout: 30000 });
    await sleep(3000); // 给动画缓冲

    // ⭐ 核心修复：精准定位 recaptcha 'anchor' 框，即使被判定为 hidden
    const anchorFrameLocator = page.frameLocator('iframe[src*="api2/anchor"]').first();
    const checkboxSelector = '#recaptcha-anchor';
    
    console.log("☑️ 尝试强制点击验证码复选框...");
    // 强点击击穿遮罩层
    await anchorFrameLocator.locator(checkboxSelector).click({ force: true, timeout: 20000 });

    console.log("🧩 等待 Buster 音频破译介入 (20s)...");
    // 给 Buster 留出寻找音频图标并点击的时间
    await sleep(20000); 
    await snap(page, "after_buster_wait");

    // 检测是否有验证码 token 生成 (Buster 成功填充的表现)
    const isTokenReady = await page.evaluate(() => {
        const t = document.querySelector('textarea[name="g-recaptcha-response"]');
        return t && t.value.length > 50;
    });

    if (isTokenReady) {
        console.log("✅ Buster 音频破译似乎已完成，准备提交");
    } else {
        console.log("⚠️ 未检测到长 Token，Buster 识别或有阻碍。尝试强制提交");
    }

    // 🚀 点击最终确认提交
    const confirmBtn = page.locator(".swal2-confirm");
    if (await confirmBtn.isVisible()) {
        await confirmBtn.click({ force: true });
    } else {
        // 如果 confirmBtn 依然被判定为 hidden，强制操作
        await page.locator(".swal2-confirm").evaluate(node => node.click()).catch(() => {});
    }

    await sleep(8000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(5000);
    await cleanUI(page);
    const after = (await page.locator("#deleteDate").textContent().catch(() => "获取失败")).trim();
    console.log(`📊 续期后: ${after}`);

    if (after !== before && after !== "获取失败") return { ok: true, before, after };
    throw new Error("数据未变化，续期可能失败");

  } catch (e) {
    console.error("💥 错误:", e.message);
    if (page) await snap(page, "error_final");
    return { ok: false, error: e.message };
  } finally {
    if (context) await context.close();
    if (hy2) hy2.kill();
  }
}

/* ========================= RUN ========================= */
(async () => {
  let res = { ok: false };
  for (let i = 1; i <= MAX_RETRY; i++) {
    console.log(`\n--- 尝试进度: ${i}/${MAX_RETRY} ---`);
    res = await renewOnce();
    if (res.ok) break;
    await sleep(5000);
  }

  const tgUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const msg = res.ok 
    ? `✅ <b>Host2Play 成功</b>\n旧日期: ${res.before}\n新日期: ${res.after}`
    : `❌ <b>Host2Play 失败</b>\n原因: ${res.error}`;

  if (TELEGRAM_BOT_TOKEN) {
    await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }),
    }).catch(() => {});
  }
  process.exit(res.ok ? 0 : 1);
})();
