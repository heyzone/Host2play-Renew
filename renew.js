const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const RENEW_URL = process.env.RENEW_URL;
const HY2_URL = process.env.HY2_URL;
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || "51080", 10);
const EXT_PATH = path.resolve(__dirname, "extensions/buster/unpacked");
const SCREEN_DIR = path.resolve(__dirname, "screenshots");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir) => !fs.existsSync(dir) && fs.mkdirSync(dir, { recursive: true });

async function snap(page, name) {
    if (!page) return;
    ensureDir(SCREEN_DIR);
    await page.screenshot({ path: path.join(SCREEN_DIR, `${Date.now()}_${name}.png`), fullPage: true });
}

/* --- 核心：强力清理广告 --- */
async function cleanUI(page) {
    await page.addStyleTag({
        content: `div[class*="translate"], .fc-consent-root, iframe[src*="googleads"] { display: none !important; }`
    }).catch(() => {});
}

/* --- 核心：暴力驱动 Buster --- */
async function driveBuster(page) {
    try {
        console.log("🛠️ 正在进入验证码 Iframe...");
        const bframe = page.frameLocator('iframe[src*="api2/bframe"]').first();
        
        // 1. 强制切换到音频挑战
        console.log("🔊 切换音频模式...");
        const audioBtn = bframe.locator('#recaptcha-audio-button');
        await audioBtn.click({ force: true, timeout: 5000 }).catch(() => {});
        await sleep(3000);

        // 2. 强制点击 Buster 识别按钮 (那个彩色小人头)
        console.log("🤖 触发 Buster 识别...");
        const solverBtn = bframe.locator('.solver-button');
        if (await solverBtn.count() > 0) {
            await solverBtn.click({ force: true });
            console.log("⏳ 等待音频破译 (可能需要30秒)...");
            await sleep(30000); // 音频识别较慢，给足时间
        } else {
            console.log("⚠️ 未发现 Buster 按钮，可能插件加载失败");
        }
    } catch (e) {
        console.log("⚠️ 驱动失败:", e.message);
    }
}

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
    await sleep(5000); // 等待启动
    return proc;
}

async function renewOnce() {
    let hy2, context, page;
    try {
        hy2 = await startHy2();
        context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "pw-")), {
            headless: false,
            args: [`--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`, `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--no-sandbox"]
        });

        page = await context.newPage();
        await page.goto(RENEW_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        await cleanUI(page);

        const before = await page.locator("#deleteDate").textContent().catch(() => "未知");
        console.log("📊 续期前:", before.trim());

        await page.click('button:has-text("Renew server")', { force: true });
        await page.waitForSelector('.swal2-popup', { state: 'attached' });
        
        // 触发复选框
        const anchorFrame = page.frameLocator('iframe[src*="api2/anchor"]').first();
        await anchorFrame.locator('#recaptcha-anchor').click({ force: true });
        await sleep(5000);

        // 核心动作：手动推 Buster 一把
        await driveBuster(page);
        await snap(page, "after_buster_action");

        // 提交
        console.log("🚀 提交确认...");
        await page.locator(".swal2-confirm").click({ force: true }).catch(() => {});
        
        await sleep(10000);
        await page.reload({ waitUntil: "domcontentloaded" });
        const after = await page.locator("#deleteDate").textContent().catch(() => "获取失败");
        console.log("📊 续期后:", after.trim());

        if (after !== before) return { ok: true, after };
        throw new Error("日期未更新");
    } catch (e) {
        console.error("💥 失败:", e.message);
        await snap(page, "final_error");
        return { ok: false, error: e.message };
    } finally {
        if (context) await context.close();
        if (hy2) hy2.kill();
    }
}

(async () => {
    const res = await renewOnce();
    if (process.env.TELEGRAM_BOT_TOKEN) {
        const text = res.ok ? `✅ Host2Play 续期成功！\n新日期: ${res.after}` : `❌ 失败: ${res.error}`;
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
        }).catch(() => {});
    }
    process.exit(res.ok ? 0 : 1);
})();
