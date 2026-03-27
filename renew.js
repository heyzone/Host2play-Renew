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
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
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
    await sleep(5000);
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
        page.setDefaultTimeout(60000);

        console.log("🌍 访问页面...");
        await page.goto(RENEW_URL, { waitUntil: "domcontentloaded" });
        await sleep(8000); // 多等几秒让 JS 加载完

        // ⭐ 修复：直接获取文本，增加容错
        const before = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "未知");
        console.log("📊 续期前:", before.trim());

        console.log("🔘 正在尝试点击 Renew 按钮 (强制模式)...");
        // ⭐ 核心修复：使用 evaluate 直接触发点击，无视“不可见”报错
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Renew server'));
            if (btn) btn.click();
            else throw new Error("找不到 Renew 按钮");
        });

        console.log("⏳ 等待弹窗...");
        await page.waitForSelector('.swal2-popup', { state: 'attached', timeout: 30000 });
        await sleep(3000);

        // 1. 触发 Recaptcha 复选框
        console.log("☑️ 触发验证码复选框...");
        const anchorFrame = page.frameLocator('iframe[src*="api2/anchor"]').first();
        await anchorFrame.locator('#recaptcha-anchor').click({ force: true });
        await sleep(5000);

        // 2. 驱动 Buster 进入音频识别
        console.log("🔊 正在切换音频并识别 (Buster)...");
        const bframe = page.frameLocator('iframe[src*="api2/bframe"]').first();
        await bframe.locator('#recaptcha-audio-button').click({ force: true }).catch(() => {});
        await sleep(3000);
        
        const solverBtn = bframe.locator('.solver-button');
        if (await solverBtn.count() > 0) {
            await solverBtn.click({ force: true });
            console.log("⏳ Buster 正在工作，请耐心等待 35s...");
            await sleep(35000); 
        }

        await snap(page, "after_buster");

        // 3. 点击最后的确认
        console.log("🚀 提交确认...");
        await page.evaluate(() => {
            const confirm = document.querySelector(".swal2-confirm");
            if (confirm) confirm.click();
        }).catch(() => {});
        
        await sleep(10000);
        await page.reload({ waitUntil: "domcontentloaded" });
        await sleep(5000);
        const after = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "获取失败");
        console.log("📊 续期后:", after.trim());

        if (after !== before && after !== "获取失败") return { ok: true, after };
        throw new Error("日期未更新，可能识别失败或被拦截");

    } catch (e) {
        console.error("💥 失败详情:", e.message);
        if (page) await snap(page, "error_trace");
        return { ok: false, error: e.message };
    } finally {
        if (context) await context.close();
        if (hy2) hy2.kill();
    }
}

(async () => {
    const res = await renewOnce();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
        const text = res.ok ? `✅ Host2Play 成功！\n新日期: ${res.after}` : `❌ 失败: ${res.error}`;
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
        }).catch(() => {});
    }
    process.exit(res.ok ? 0 : 1);
})();
