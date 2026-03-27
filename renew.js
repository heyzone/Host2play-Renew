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
    await sleep(6000); 
    return proc;
}

/* ========================= RENEW FLOW ========================= */
async function renewOnce() {
    let hy2, context, page;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

    try {
        hy2 = await startHy2();
        
        // ⭐ 增强：伪装环境
        context = await chromium.launchPersistentContext(profile, {
            headless: false,
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            args: [
                `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`,
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled" // 隐藏自动化标识
            ]
        });

        page = await context.newPage();
        page.setDefaultTimeout(90000);

        console.log("🌍 正在访问 Host2Play...");
        await page.goto(RENEW_URL, { waitUntil: "domcontentloaded" });

        // ⭐ 拟人化：静默等待并滚动，让 Google 觉得你是个真人在看网页
        console.log("⏳ 模拟阅读页面 (25s)...");
        await sleep(15000);
        await page.evaluate(() => window.scrollBy(0, 400));
        await sleep(10000);

        const before = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "未知");
        console.log("📊 续期前:", before.trim());

        console.log("🔘 尝试点击 Renew 按钮 (JS 暴力触发)...");
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const renewBtn = btns.find(b => b.innerText.includes('Renew server'));
            if (renewBtn) renewBtn.click();
        });

        await page.waitForSelector('.swal2-popup', { state: 'attached' });
        await sleep(4000);

        // --- 验证码逻辑开始 ---
        const anchorFrame = page.frameLocator('iframe[src*="api2/anchor"]').first();
        await anchorFrame.locator('#recaptcha-anchor').click({ force: true });
        console.log("☑️ 已点击复选框");
        await sleep(6000);

        const bframe = page.frameLocator('iframe[src*="api2/bframe"]').first();
        
        // ⭐ 关键检测：是否由于 IP 风险被封锁
        const blocked = await bframe.locator('.rc-doscaptcha-body-text').isVisible().catch(() => false);
        if (blocked) {
            const reason = await bframe.locator('.rc-doscaptcha-body-text').innerText();
            if (reason.includes("Try again later")) {
                throw new Error("🚫 Google 封锁了此 IP (Try again later)，请更换 Hysteria2 节点！");
            }
        }

        console.log("🔊 切换音频并唤醒 Buster...");
        await bframe.locator('#recaptcha-audio-button').click({ force: true }).catch(() => {});
        await sleep(3000);
        
        const solverBtn = bframe.locator('.solver-button');
        if (await solverBtn.count() > 0) {
            await solverBtn.click({ force: true });
            console.log("⏳ Buster 正在破译音频 (40s)...");
            await sleep(40000); 
        } else {
            console.log("⚠️ 未在 Bframe 中发现 Buster 按钮");
        }

        await snap(page, "after_buster_process");

        // 提交确认
        console.log("🚀 执行最终确认提交...");
        await page.evaluate(() => {
            const confirm = document.querySelector(".swal2-confirm");
            if (confirm) confirm.click();
        }).catch(() => {});
        
        await sleep(12000);
        await page.reload({ waitUntil: "domcontentloaded" });
        await sleep(5000);
        const after = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "获取失败");
        console.log("📊 续期后:", after.trim());

        if (after !== before && after !== "获取失败") return { ok: true, before, after };
        throw new Error("日期未更新，续期可能未生效");

    } catch (e) {
        console.error("💥 流程中断:", e.message);
        if (page) await snap(page, "error_trace");
        return { ok: false, error: e.message };
    } finally {
        if (context) await context.close().catch(() => {});
        if (hy2) hy2.kill();
    }
}

/* ========================= MAIN ========================= */
(async () => {
    let res = { ok: false };
    for (let i = 1; i <= MAX_RETRY; i++) {
        console.log(`\n--- 尝试第 ${i}/${MAX_RETRY} 次 ---`);
        res = await renewOnce();
        if (res.ok) break;
        console.log("🔄 准备下次重试...");
        await sleep(10000);
    }

    if (process.env.TELEGRAM_BOT_TOKEN) {
        const text = res.ok 
            ? `✅ <b>Host2Play 续期成功</b>\n${res.after}` 
            : `❌ <b>Host2Play 失败</b>\n原因: ${res.error}`;
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
        }).catch(() => {});
    }
    process.exit(res.ok ? 0 : 1);
})();
