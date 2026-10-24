// Hub skills UI end-to-end run: log in with the user key read from
// USER_KEY_FILE (never printed), run the click steps given as JSON in argv[2],
// and write screenshots to OUT_DIR. Usage:
//   PLAYWRIGHT_CORE_DIR=<node_modules> node hub-skills-e2e.mjs '[{"click":"text=Skills","wait":2000,"shot":"list"}]'
import { createRequire } from "node:module";
import fs from "node:fs";
// PLAYWRIGHT_CORE_DIR points at a node_modules folder that has playwright-core.
const require = createRequire((process.env.PLAYWRIGHT_CORE_DIR ?? process.cwd() + "/node_modules") + "/");
const { chromium } = require("playwright-core");
const key = fs.readFileSync(process.env.USER_KEY_FILE ?? process.env.HOME + "/.cache/am-e2e/user_key", "utf8").trim();
const out = process.env.OUT_DIR ?? process.env.HOME + "/.cache/am-e2e/ui";
const exe = fs.readdirSync(process.env.HOME + "/Library/Caches/ms-playwright").filter(d => d.startsWith("chromium-")).sort().pop();
const browser = await chromium.launch({ executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/${exe}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("response", r => { if (r.status() >= 500) errors.push(`${r.status()} ${r.request().method()} ${r.url().split("?")[0]}`); });
page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Warning:")) errors.push(m.text().slice(0, 300)); });
await page.goto(process.env.HUB_URL ?? "http://localhost:5173/");
await page.fill('input[placeholder*="sk-mem"]', key);
await page.click('button:has-text("Log In")');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/0-after-login.png` });
const steps = JSON.parse(process.argv[2] || "[]");
for (const s of steps) {
  if (s.goto) await page.goto(s.goto);
  if (s.click) await page.click(s.click, { timeout: 8000 }).catch(e => errors.push(`click ${s.click}: ${e.message.split("\n")[0]}`));
  if (s.scroll) await page.evaluate(() => { for (const el of document.querySelectorAll("*")) { if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight; } window.scrollTo(0, document.body.scrollHeight); });
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.shot) await page.screenshot({ path: `${out}/${s.shot}.png`, fullPage: !!s.full });
}
console.log(JSON.stringify({ url: page.url(), errors: errors.slice(0, 15) }));
await browser.close();
