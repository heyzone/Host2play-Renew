const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

/* ========================= 配置区 ========================= */
const RENEW_URL = process.env.RENEW_URL;
const HY2_URL = process.env.HY2_URL;
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || "51080", 10);
const MAX_RETRY = 3;

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

/* ========================= 代理启动 ========================= */
async function startHy2() {
    if (!HY2_URL) throw new Error("HY2_URL 未设置");
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

/* ========================= 核心续费流程 ========================= */
async function renewOnce() {
    let hy2, context, page;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

    try {
        hy2 = await startHy2();
        
        context = await chromium.launchPersistentContext(profile, {
            headless: false,
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            args: [
                `--proxy-server=socks5://127.0.0.1:${SOCKS_PORT}`,
                `--disable-extensions-except=${EXT_PATH}`,
                `--load-extension=${EXT_PATH}`,
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled"
            ]
        });

        page = await context.newPage();
        page.setDefaultTimeout(90000);

        console.log("🌍 访问 Host2Play...");
        await page.goto(RENEW_URL, { waitUntil: "domcontentloaded" });

        console.log("⏳ 模拟人类行为 (25s)...");
        await sleep(15000);
        await page.evaluate(() => window.scrollBy(0, 400));
        await sleep(10000);

        const before = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "未知");
        console.log("📊 续期前:", before.trim());

        console.log("🔘 触发 Renew 按钮...");
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Renew server'));
            if (btn) btn.click();
        });

        await page.waitForSelector('.swal2-popup', { state: 'attached' });
        await sleep(5000);

        // --- 验证码逻辑 ---
        const anchorFrame = page.frameLocator('iframe[src*="api2/anchor"]').first();
        await anchorFrame.locator('#recaptcha-anchor').click({ force: true });
        console.log("☑️ 已点击复选框，等待挑战框...");
        await sleep(8000); 

        const bframe = page.frameLocator('iframe[src*="api2/bframe"]').first();
        
        // ⭐ 插件探测逻辑：如果没看到 Buster，手动点一下音频图标激活
        console.log("🔎 探测 Buster 状态...");
        let solverBtn = bframe.locator('.solver-button');
        if (await solverBtn.count() === 0) {
            console.log("⚠️ Buster 未出现，尝试切换音频模式强制唤醒...");
            await bframe.locator('#recaptcha-audio-button').click({ force: true }).catch(() => {});
            await sleep(4000);
        }

        if (await solverBtn.count() > 0) {
            console.log("🤖 Buster 已就绪，开始破译...");
            await solverBtn.click({ force: true });
            // 音频识别需要联网且较慢，给足 45 秒
            await sleep(45000); 
        } else {
            console.log("❌ 无法激活 Buster，可能是 IP 风险导致音频接口被封");
            await snap(page, "buster_failed_debug");
        }

        await snap(page, "after_process_check");

        // ⭐ 暴力提交：确保点击的是弹窗确认按钮
        console.log("🚀 执行确认提交...");
        await page.evaluate(() => {
            const confirm = document.querySelector(".swal2-confirm");
            if (confirm) {
                confirm.scrollIntoView();
                confirm.click();
            }
        }).catch(() => {});
        
        await sleep(12000);
        await page.reload({ waitUntil: "domcontentloaded" });
        await sleep(5000);
        
        const after = await page.evaluate(() => document.querySelector("#deleteDate")?.innerText || "获取失败");
        console.log("📊 续期后:", after.trim());

        if (after !== before && after !== "获取失败") return { ok: true, before, after };
        throw new Error("日期未变化，可能破译未成功或提交被拦截");

    } catch (e) {
        console.error("💥 错误详情:", e.message);
        if (page) await snap(page, "error_final");
        return { ok: false, error: e.message };
    } finally {
        if (context) await context.close().catch(() => {});
        if (hy2) hy2.kill();
    }
}

/* ========================= 入口 ========================= */
(async () => {
    let finalRes = { ok: false };
    for (let i = 1; i <= MAX_RETRY; i++) {
        console.log(`\n--- 第 ${i} 次尝试 ---`);
        finalRes = await renewOnce();
        if (finalRes.ok) break;
        await sleep(10000);
    }

    if (process.env.TELEGRAM_BOT_TOKEN) {
        const text = finalRes.ok 
            ? `✅ <b>Host2Play 续期成功</b>\n${finalRes.after}` 
            : `❌ <b>Host2Play 续期失败</b>\n原因: ${finalRes.error}`;
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
        }).catch(() => {});
    }
    process.exit(finalRes.ok ? 0 : 1);
})();
