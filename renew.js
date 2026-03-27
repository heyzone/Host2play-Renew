const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

/* ========================= CONFIG ========================= */

const RENEW_URL =
  process.env.RENEW_URL ||
  "https://host2play.gratis/server/renew?i=766827c0-a9a5-4e80-bc9a-4d50bfe9818e";

const HY2_URL =
  process.env.HY2_URL ||
  "hysteria2://0a6568ff-ea3c-4271-9020-450560e10d63@38.58.180.137:3003/?sni=www.bing.com&alpn=h3&insecure=1";

const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || "51080", 10);
const MAX_RETRY = parseInt(process.env.MAX_RETRY || "2", 10);

const EXT_NOPECHA = path.resolve(__dirname, "extensions/nopecha/unpacked");
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
  } catch {}
}

async function dumpHTML(page, name) {
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.html`);
    fs.writeFileSync(file, await page.content(), "utf-8");
    console.log("🧾 HTML Dump:", file);
  } catch {}
}

/* ========================= 广告增强（安全版） ========================= */

async function blockAds(context) {
  await context.route("**/*", (route) => {
    const url = route.request().url();

    if (
      url.includes("doubleclick") ||
      url.includes("googlesyndication") ||
      url.includes("adservice") ||
      url.includes("adsystem") ||
      url.includes("exoclick") ||
      url.includes("popads")
    ) {
      return route.abort();
    }

    route.continue();
  });
}

async function hideAdsByCSS(page) {
  await page.addStyleTag({
    content: `
      iframe[src*="doubleclick"],
      iframe[src*="googlesyndication"],
      iframe[src*="exoclick"],
      iframe[src*="popads"] {
        display:none !important;
      }
    `,
  });
}

async function removeOverlay(page) {
  await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("*"));

    elements.forEach(el => {
      const style = window.getComputedStyle(el);

      const isOverlay =
        style.position === "fixed" &&
        parseInt(style.zIndex || "0") > 1000 &&
        el.offsetWidth > 200 &&
        el.offsetHeight > 200;

      if (isOverlay && !el.innerText.includes("Renew server")) {
        el.remove();
      }
    });

    document.body.style.overflow = "auto";
  });
}

/* ========================= TELEGRAM ========================= */

async function sendTelegram(text) {
  try {
    if (!TELEGRAM_CHAT_ID || !TELEGRAM_BOT_TOKEN) return;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    const data = await r.json();

    if (!data.ok) {
      console.log("⚠️ Telegram send failed:", data);
    }
  } catch (e) {
    console.log("⚠️ Telegram error:", e?.message || e);
  }
}

/* ========================= CONSENT ========================= */

async function handleConsent(page) {
  try {
    const btn = page
      .locator(
        'button:has-text("Consent"), button:has-text("Accept"), button:has-text("Agree"), button:has-text("Allow")'
      )
      .first();

    if (await btn.isVisible({ timeout: 5000 })) {
      await btn.click({ force: true });
      await page.waitForTimeout(1500);
    }
  } catch {}

  try {
    await page.evaluate(() => {
      document
        .querySelectorAll(
          "#fc-consent-root, .fc-dialog-overlay, .fc-consent-root"
        )
        .forEach((e) => e.remove());
    });
  } catch {}
}

/* ========================= READ SERVER INFO ========================= */

async function readServerInfo(page, tag) {
  try {
    const name = (await page.locator("#serverName").textContent())?.trim();
    const expire = (await page.locator("#expireDate").textContent())?.trim();
    const del = (await page.locator("#deleteDate").textContent())?.trim();

    console.log(`📊 [${tag}] 服务器: ${name} `);
    console.log(`📊 [${tag}] 剩余时间: ${expire}`);
    console.log(`📊 [${tag}] 删除时间: ${del}`);

    return { name, expire, del };
  } catch {
    console.log(`⚠️ [${tag}] 无法读取服务器信息`);
    return null;
  }
}

/* ========================= HY2 ========================= */

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
  while (Date.now() - start < 15000) {
    await sleep(1000);

    const ok = await new Promise((res) => {
      const s = net.createConnection(port, "127.0.0.1");
      s.on("connect", () => {
        s.destroy();
        res(true);
      });
      s.on("error", () => res(false));
    });

    if (ok) return true;
  }
  return false;
}

async function startHy2() {
  if (!HY2_URL) throw new Error("❌ HY2_URL 未设置");

  const cfg = parseHy2(HY2_URL);
  const cfgPath = "/tmp/hy2.json";

  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        server: cfg.server,
        auth: cfg.auth,
        tls: { sni: cfg.sni, insecure: cfg.insecure, alpn: [cfg.alpn] },
        socks5: { listen: `127.0.0.1:${SOCKS_PORT}` },
      },
      null,
      2
    )
  );

  console.log("🚀 启动 hysteria2 client...");

  const proc = spawn("hysteria", ["client", "-c", cfgPath], {
    stdio: "ignore",
    detached: true,
  });

  if (!(await waitPort(SOCKS_PORT))) {
    throw new Error("❌ Hy2 socks5 未就绪");
  }

  console.log(`✅ Hy2 socks5 已就绪: 127.0.0.1:${SOCKS_PORT}`);
  return proc;
}

/* ========================= EXTENSION CHECK ========================= */

async function waitExtensionLoaded(context) {
  console.log("🧩 等待 加载...");

  for (let i = 0; i < 40; i++) {
    const sw = context.serviceWorkers();
    const bg = context.backgroundPages();

    if (sw.length > 0 || bg.length > 0) {
      console.log(`✅ 加载已完成`);
      return true;
    }

    await sleep(500);
  }

  return false;
}

/* ========================= PLAYWRIGHT EXIT IP CHECK ========================= */

async function checkBrowserExitIP(context) {
  console.log("🌍 [Browser] 检测 Playwright 出口 IP...");

  const apis = [
    {
      url: "https://ip.eooce.com/",
      parse: (data) => ({
        ip: data.ip,
        cc: data.country_code,
        org: data.organization,
      }),
    },
    {
      url: "https://api.ip.sb/geoip",
      parse: (data) => ({
        ip: data.ip,
        cc: data.country_code,
        org: data.isp || data.org,
      }),
    },
    {
      url: "https://ipapi.co/json",
      parse: (data) => ({
        ip: data.ip,
        cc: data.country_code,
        org: data.org,
      }),
    },
    {
      url: "https://api.ipify.org?format=json",
      parse: (data) => ({
        ip: data.ip,
        cc: "",
        org: "",
      }),
    },
  ];

  let page = null;

  try {
    page = await context.newPage();
    page.setDefaultTimeout(15000);

    for (const api of apis) {
      try {
        const resp = await page.goto(api.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });

        if (!resp) continue;

        console.log(`🌍 [Browser]  status: ${resp.status()}`);

        if (resp.status() >= 400) continue;

        const bodyText = await page.evaluate(() => document.body.innerText);
        let json;

        try {
          json = JSON.parse(bodyText);
        } catch {
          console.log("⚠️ [Browser] JSON parse failed:", bodyText.slice(0, 200));
          continue;
        }

        const info = api.parse(json);

        if (info && info.ip) {
          const masked = maskIP(info.ip);
          const label = [info.cc, info.org].filter(Boolean).join("-");

          console.log(`🌍 Playwright 出口 IP: ${masked} (${label})`);
          return `${masked}${label ? " (" + label + ")" : ""}`;
        }
      } catch (e) {
        console.log(
          `⚠️ [Browser] ${api.url} 查询失败:`,
          e?.message || e
        );
        continue;
      }
    }

    console.log("🌍 Playwright 出口 IP: 未知 IP");
    return "未知 IP";
  } finally {
    try {
      if (page) await page.close();
    } catch {}
  }
}

/* ========================= CAPTCHA ========================= */

async function clickRecaptchaCheckbox(page) {
  console.log("☑️ 等待 recaptcha anchor iframe...");

  const iframeHandle = await page.waitForSelector(
    'iframe[src*="recaptcha/api2/anchor"]',
    { timeout: 300000 }
  );

  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error("❌ 无法获取 anchor iframe frame");

  const checkbox = await frame.waitForSelector("#recaptcha-anchor", {
    timeout: 60000,
  });

  console.log("🖱️ 点击 recaptcha checkbox");
  await checkbox.click({ force: true });

  await page.waitForTimeout(2000);
}

async function waitTokenAllFrames(page, timeoutMs = 300000) {
  console.log("⏳ 等待   生成 token...");

  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      try {
        const token = await frame.evaluate(() => {
          const t = document.querySelector(
            "textarea[name='g-recaptcha-response']"
          );
          return t?.value || "";
        });

        if (token && token.length > 30) {
          console.log("✅ Token 已生成:", token.slice(0, 12) + "...");
          return token;
        }
      } catch {}
    }

    await page.waitForTimeout(2000);
  }

  throw new Error("❌ Token 等待超时");
}
/* ========================= MAIN FLOW ========================= */

async function renewOnce() {
  ensureScreenDir();

  let hy2 = null;
  let page = null;
  let context = null;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  try {
    if (!fs.existsSync(path.join(EXT_NOPECHA, "manifest.json"))) {
      throw new Error("❌ NopeCHA manifest.json 不存在");
    }

    hy2 = await startHy2();
    await sleep(2000);

    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      slowMo: 40,
      viewport: { width: 1280, height: 720 },
      args: [
        `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
        `--disable-extensions-except=${EXT_NOPECHA}`,
        `--load-extension=${EXT_NOPECHA}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    context.setDefaultTimeout(180000);

    await blockAds(context);

    const okExt = await waitExtensionLoaded(context);
    if (!okExt) throw new Error("❌ 扩展未加载成功");

    const exitIP = await checkBrowserExitIP(context);

    page = await context.newPage();

    console.log("🌍 打开 renew 页面");
    await page.goto(RENEW_URL, {
      waitUntil: "networkidle",
      timeout: 180000,
    });

    await page.waitForTimeout(2000);

    await hideAdsByCSS(page);
    await removeOverlay(page);
    await handleConsent(page);

    const before = await readServerInfo(page, "续期前");

    console.log("🟢 点击 Renew server");

    const renewBtn = page.getByRole("button", { name: /^Renew server$/i });
    await renewBtn.waitFor({ timeout: 60000 });
    await renewBtn.click({ force: true });

    console.log("⏳ 等待 swal2 弹窗...");
    await page.waitForSelector(".swal2-popup", { timeout: 300000 });

    await page.waitForTimeout(1200);

    console.log("🧩 点击 recaptcha checkbox");
    await clickRecaptchaCheckbox(page);

    await waitTokenAllFrames(page, 300000);

    await snap(page, "captcha_passed");

    console.log("🟢 点击最终确认按钮");

    const confirmBtn = page.locator(".swal2-confirm");
    await confirmBtn.waitFor({ timeout: 60000 });
    await confirmBtn.click({ force: true });

    // ✅ 等 swal2 关闭
    await page.waitForSelector(".swal2-popup", {
      state: "hidden",
      timeout: 180000,
    });

    // ✅ 如果有 loading，等它结束
    const spinner = page.locator(".loading-spinner");
    if (await spinner.count()) {
      await spinner
        .waitFor({ state: "hidden", timeout: 180000 })
        .catch(() => {});
    }

    // ✅ 强制刷新页面（关键步骤）
    console.log("🔄 强制刷新页面获取最新数据...");
    await page.reload({
      waitUntil: "networkidle",
      timeout: 180000,
    });

    await page.waitForTimeout(2000);

    await hideAdsByCSS(page);
    await removeOverlay(page);
    await handleConsent(page);

    await page.locator("#expireDate").waitFor({ timeout: 60000 });

    await snap(page, "renew_done");

    const after = await readServerInfo(page, "续期后");

    // ✅ 成功校验：删除时间或剩余时间应变化
    if (
      !after ||
      (before?.expire === after?.expire &&
        before?.del === after?.del)
    ) {
      throw new Error("❌ 续期后数据未变化，可能未成功");
    }

    console.log("🎉 续期流程完成");

    return { ok: true, before, after, exitIP };

  } catch (e) {
    const msg = e?.message || String(e);
    console.error("💥 renewOnce error:", msg);

    if (page) {
      await snap(page, "error");
      await dumpHTML(page, "error");
    }

    return { ok: false, error: msg };
  } finally {
    try {
      if (context) await context.close();
    } catch {}

    try {
      if (hy2) hy2.kill("SIGTERM");
    } catch {}
  }
}

/* ========================= ENTRY ========================= */

(async () => {
  let lastError = "";
  let successResult = null;

  for (let i = 1; i <= MAX_RETRY; i++) {
    console.log(`\n🔄 尝试 ${i}/${MAX_RETRY}\n`);
    const result = await renewOnce();

    if (result.ok) {
      successResult = result;
      break;
    }

    lastError = result.error || "未知错误";
    console.log("⚠️ 本次失败，准备重试...");
    await sleep(4000);
  }

  if (successResult) {
    const { before, after, exitIP } = successResult;

    if (before && after) {
      const msg =
        `✅ <b>Host2Play Renew Success</b>\n\n` +
        `🌍 <b>Exit IP</b>: ${exitIP}\n\n` +
        `🖥 <b>Server</b>: ${after.name}\n\n` +
        `⏳ <b>Before</b>: ${before.expire}\n` +
        `🗑 <b>Delete</b>: ${before.del}\n\n` +
        `⏳ <b>After</b>: ${after.expire}\n` +
        `🗑 <b>Delete</b>: ${after.del}`;

      await sendTelegram(msg);
    }

    process.exit(0);
  }

  await sendTelegram(
    `❌ <b>Host2Play Renew Failed</b>\n\n<code>${lastError}</code>`
  );

  console.log("❌ 多次尝试仍失败，退出");
  process.exit(1);
})();
