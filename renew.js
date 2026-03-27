const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
// ⭐ 核心变化：使用 extra 和 stealth 插件
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

/* ========================= 配置区 ========================= */
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
    await page.screenshot({ path: path.join(SCREEN_DIR, `${Date.now()}_${name}.png`), fullPage: true }).catch(() => {});
}

/* ========================= 代理逻辑 ========================= */
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
    await sleep(6000); 
    return proc;
}

/* ========================= 核心流程 ========================= */
async function renewOnce() {
    let hy2, context, page;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-stealth-"));

    try {
        hy2 = await startHy2();
        
        console.log("🕵️ 正在启动 Stealth 混淆浏览器...");
        context = await chromium.launchPersistentContext(profile, {
            headless: false,
            // 抹除各种自动化痕迹
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
                `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`,
                "--no-sandbox",
                "--disable-infobars",
                "--window-size=1280,720"
            ]
        });

        page = await context.newPage();
        // 抹除 webdriver 特征
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        console.log("🌍 访问 Host2Play...");
        await page.goto(RENEW_URL, { waitUntil: "networkidle", timeout: 60000 });

        // 随机滚动
        console.log("⏳ 模拟真人随机滚动和停留...");
        await page.mouse.move(Math.random()*500, Math.random()*500);
        await sleep(15000);
        await page.evaluate(() => window.scrollBy(0, Math.random()*300 + 200));
        await sleep(10000);

        const before = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "未知");
        console.log("📊 续期前:", before.trim());

        console.log("🔘 暴力点击 Renew...");
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Renew server'));
            if (btn) btn.click();
        });

        await page.waitForSelector('.swal2-popup', { state: 'attached' });
        await sleep(5000);

        // --- 验证码核心突破 ---
        const anchorFrame = page.frameLocator('iframe[src*="api2/anchor"]').first();
        await anchorFrame.locator('#recaptcha-anchor').click({ force: true });
        console.log("☑️ 复选框已点，等待 10s 观察弹窗...");
        await sleep(10000);

        const bframe = page.frameLocator('iframe[src*="api2/bframe"]').first();
        
        // 尝试刷出 Buster
        let solverBtn = bframe.locator('.solver-button');
        if (await solverBtn.count() === 0) {
            console.log("🔄 未发现图标，尝试切换音频模式强制唤醒...");
            await bframe.locator('#recaptcha-audio-button').click({ force: true }).catch(() => {});
            await sleep(5000);
        }

        if (await solverBtn.count() > 0) {
            console.log("🚀 Buster 发现！开始破译...");
            await solverBtn.click({ force: true });
            // 给足识别时间
            for (let i = 0; i < 10; i++) {
                console.log(`⏳ 等待破译中 (${i*5}s)...`);
                await sleep(5000);
                // 检查是否打钩
                const isChecked = await anchorFrame.locator('.recaptcha-checkbox-checked').count() > 0;
                if (isChecked) {
                    console.log("✅ 验证码已打钩！");
                    break;
                }
            }
        } else {
            console.log("❌ 依旧无法唤醒 Buster，尝试最后一次强点确认（靠运气）");
        }

        await snap(page, "final_status");

        console.log("🚀 点击确认提交...");
        await page.evaluate(() => {
            const confirm = document.querySelector(".swal2-confirm");
            if (confirm) confirm.click();
        }).catch(() => {});
        
        await sleep(15000);
        await page.reload({ waitUntil: "domcontentloaded" });
        const after = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "获取失败");
        console.log("📊 续期后:", after.trim());

        if (after !== before && after !== "获取失败") return { ok: true, after };
        throw new Error("日期未更新");

    } catch (e) {
        console.error("💥 失败:", e.message);
        if (page) await snap(page, "stealth_error");
        return { ok: false, error: e.message };
    } finally {
        if (context) await context.close().catch(() => {});
        if (hy2) hy2.kill();
    }
}

(async () => {
    let res = { ok: false };
    for (let i = 1; i <= 2; i++) {
        console.log(`\n--- 尝试第 ${i}/2 次 ---`);
        res = await renewOnce();
        if (res.ok) break;
        await sleep(10000);
    }

    if (process.env.TELEGRAM_BOT_TOKEN) {
        const text = res.ok ? `✅ Host2Play 续期成功\n新日期: ${res.after}` : `❌ 失败: ${res.error}`;
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
        }).catch(() => {});
    }
    process.exit(res.ok ? 0 : 1);
})();
