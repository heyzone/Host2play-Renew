const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

/* ========================= CONFIG ========================= */

// 优先从环境变量读取，Secret 注入的点
const RENEW_URL = process.env.RENEW_URL;
const HY2_URL = process.env.HY2_URL;

const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || "51080", 10);
const MAX_RETRY = parseInt(process.env.MAX_RETRY || "3", 10);

// ⭐ 关键修改：匹配 renew.yml 中的下载路径
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
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  return ip;
}

async function snap(page, name) {
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("📸 Screenshot:", file);
  } catch (e) {
    console.log("⚠️ Screenshot failed:", e.message);
  }
}

async function dumpHTML(page, name) {
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.html`);
    fs.writeFileSync(file, await page.content(), "utf-8");
    console.log("🧾 HTML Dump:", file);
  } catch {}
}

/* ========================= 广告/干扰过滤 ========================= */

async function blockAds(context) {
  await context.route("**/*", (route) => {
    const url = route.request().url();
    const resourceType = route.request().resourceType();

    // 拦截常见广告域名和无用资源（提升加载速度）
    if (
      url.includes("doubleclick") ||
      url.includes("googlesyndication") ||
      url.includes("exoclick") ||
      url.includes("popads") ||
      ["image", "media", "font"].includes(resourceType) && !url.includes("captcha") // 排除验证码相关的图片
    ) {
      return route.abort();
    }
    route.continue();
  });
}

async function cleanUI(page) {
  try {
    await page.addStyleTag({
      content: `
        iframe[src*="doubleclick"], .fc-consent-root, .swal2-backdrop-show { 
          z-index: -1 !important; 
          display: none !important; 
        }
        body { overflow: auto !important; }
      `,
    });
    // 移除遮挡物
    await page.evaluate(() => {
      document.querySelectorAll('#fc-consent-root, .fc-dialog-overlay').forEach(e => e.remove());
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
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.log("⚠️ Telegram error:", e.message);
  }
}

/* ========================= SERVER INFO ========================= */

async function readServerInfo(page, tag) {
  try {
    const name = (await page.locator("#serverName").textContent())?.trim();
    const expire = (await page.locator("#expireDate").textContent())?.trim();
    const del = (await page.locator("#deleteDate").textContent())?.trim();

    console.log(`📊 [${tag}] 服务器: ${name} | 剩余: ${expire} | 删除: ${del}`);
    return { name, expire, del };
  } catch {
    console.log(`⚠️ [${tag}] 无法读取服务器信息，可能页面未加载完成`);
    return null;
  }
}

/* ========================= HY2 PROXY ========================= */

function parseHy2(url) {
  const u = url.replace("hysteria2://", "");
  const parsed = new URL("scheme://" + u);
  return {
    server: `${parsed.hostname}:${parsed.port}`,
    auth: decodeURIComponent(parsed.username),
    sni: parsed.searchParams.get("sni") || parsed.hostname,
    insecure: parsed.searchParams.get("insecure") === "1",
    alpn: parsed.searchParams.get("alpn") || "h3",
  };
}

async function waitPort(port) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    await sleep(1000);
    const ok = await new Promise((res) => {
      const s = net.createConnection(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); res(true); });
      s.on("error", () => res(false));
    });
    if (ok) return true;
  }
  return false;
}

async function startHy2() {
  if (!HY2_URL) throw new Error("❌ HY2_URL Secret 未设置");
  const cfg = parseHy2(HY2_URL);
  const cfgPath = path.join(os.tmpdir(), "hy2.json");

  fs.writeFileSync(cfgPath, JSON.stringify({
    server: cfg.server,
    auth: cfg.auth,
    tls: { sni: cfg.sni, insecure: cfg.insecure, alpn: [cfg.alpn] },
    socks5: { listen: `127.0.0.1:${SOCKS_PORT}` },
  }));

  const proc = spawn("hysteria", ["client", "-c", cfgPath]);
  
  if (!(await waitPort(SOCKS_PORT))) {
    throw new Error("❌ Hy2 代理启动超时");
  }
  return proc;
}

/* ========================= BROWSER IP CHECK ========================= */

async function checkExitIP(context) {
  const page = await context.newPage();
  try {
    await page.goto("https://api.ip.sb/geoip", { timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    const json = JSON.parse(text);
    const info = `${maskIP(json.ip)} (${json.country_code}-${json.isp || ""})`;
    console.log(`🌍 出口 IP: ${info}`);
    return info;
  } catch {
    return "未知 IP";
  } finally {
    await page.close();
  }
}

/* ========================= MAIN FLOW ========================= */

async function renewOnce() {
  let hy2 = null, context = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  try {
    // 核心路径检查
    if (!fs.existsSync(path.join(EXT_BUSTER, "manifest.json"))) {
      throw new Error(`❌ Buster 插件未找到: ${EXT_BUSTER}`);
    }

    hy2 = await startHy2();
    
    context = await chromium.launchPersistentContext(profile, {
      headless: false, // 必须为 false 才能加载扩展
      viewport: { width: 1280, height: 800 },
      args: [
        `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
        `--disable-extensions-except=${EXT_BUSTER}`,
        `--load-extension=${EXT_BUSTER}`,
        "--no-sandbox",
      ],
    });

    await blockAds(context);
    const exitIP = await checkExitIP(context);
    const page = await context.newPage();

    console.log("🔗 正在打开续期页面...");
    await page.goto(RENEW_URL, { waitUntil: "networkidle", timeout: 90000 });
    
    await cleanUI(page);
    const before = await readServerInfo(page, "续期前");

    console.log("🔘 点击 Renew 按钮");
    await page.click('button:has-text("Renew server")', { timeout: 30000 });

    // 等待 ReCAPTCHA 出现并处理
    console.log("🧩 等待验证码并让 Buster 处理...");
    await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 30000 });
    
    // 给 Buster 一点时间自动执行
    await sleep(10000); 
    await snap(page, "captcha_solving");

    console.log("✅ 尝试提交...");
    const confirmBtn = page.locator(".swal2-confirm");
    if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
    }

    // 等待处理完成
    await sleep(5000);
    await page.reload({ waitUntil: "networkidle" });
    const after = await readServerInfo(page, "续期后");

    if (after && before && after.del !== before.del) {
        return { ok: true, before, after, exitIP };
    } else {
        throw new Error("续期数据未变化，可能验证失败");
    }

  } catch (e) {
    console.error("💥 错误:", e.message);
    return { ok: false, error: e.message };
  } finally {
    if (context) await context.close();
    if (hy2) hy2.kill();
  }
}

/* ========================= ENTRY ========================= */

(async () => {
  if (!RENEW_URL) {
    console.error("❌ 错误: RENEW_URL 未设置，请在 Secrets 中配置");
    process.exit(1);
  }

  let result = null;
  for (let i = 1; i <= MAX_RETRY; i++) {
    console.log(`\n--- 第 ${i} 次尝试 ---`);
    result = await renewOnce();
    if (result.ok) break;
    await sleep(5000);
  }

  if (result.ok) {
    const { before, after, exitIP } = result;
    await sendTelegram(`✅ <b>Host2Play 续期成功</b>\n🌍 IP: ${exitIP}\n🖥 Server: ${after.name}\n⏳ 后推至: ${after.del}`);
    process.exit(0);
  } else {
    await sendTelegram(`❌ <b>Host2Play 续期失败</b>\n原因: ${result.error}`);
    process.exit(1);
  }
})();
