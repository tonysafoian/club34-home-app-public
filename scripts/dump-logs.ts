import { chromium } from "playwright";

async function main() {
  console.log("Connecting to Chrome on port 9222...");
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  
  const contexts = browser.contexts();
  let page = null;
  for (const context of contexts) {
    const pages = context.pages();
    for (const p of pages) {
      const url = p.url();
      if (url.includes("replit.com")) {
        page = p;
        console.log(`Found active Replit page: ${url}`);
      }
    }
  }
  
  if (!page) {
    console.log("No active Replit page found.");
    await browser.close();
    return;
  }
  
  await page.bringToFront();
  
  const logs = await page.evaluate(() => {
    // Let's find any text blocks containing log messages in the right pane
    const rightSideElements = Array.from(document.querySelectorAll('*'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.55 && rect.width > 0 && rect.height > 0;
      });

    // Let's look for element content that contains error or timestamp
    const textBlocks: string[] = [];
    const elements = document.querySelectorAll('div, span, tr, li, p');
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.55 && rect.width > 100) {
        const text = el.textContent?.trim();
        // Look for rows that have log messages
        if (text && (text.includes("2026-05") || text.includes("Error") || text.includes("Exception") || text.includes("500") || text.includes("broadcast") || text.includes("failed") || text.includes("SSID"))) {
          if (!textBlocks.includes(text) && text.length < 1000) {
            textBlocks.push(text);
          }
        }
      }
    }
    return textBlocks;
  });
  
  console.log("\n--- DUMPED LOGS ---");
  for (const log of logs) {
    console.log(log);
  }
  console.log("-------------------");
  
  await browser.close();
}

main().catch(console.error);
