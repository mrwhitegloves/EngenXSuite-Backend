import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// The ONE place that turns HTML into a PDF (Document generator, founder 2026-11-12). It starts
// the Chromium browser installed on the machine (the server image installs it; locally Chrome
// or Edge), prints one page and closes it again, so nothing stays in memory between downloads.
// The HTML comes from a signed-in user's screen, so the page is locked down:
// - its JavaScript is switched off;
// - every request except data: addresses is refused (no internal address can be reached, no
//   file can be read), so styles and pictures must be inside the HTML;
// - one PDF at a time (the VM is small); a render that takes too long is stopped.

const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const RENDER_TIMEOUT_MS = 45_000;

/** The browser to use, or null when none is installed. CHROMIUM_PATH wins when set. */
export function findBrowser() {
  if (env.CHROMIUM_PATH) return existsSync(env.CHROMIUM_PATH) ? env.CHROMIUM_PATH : null;
  return CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

export const isPdfRendererAvailable = () => Boolean(findBrowser());

// One render at a time: each waits for the one before it.
let queue = Promise.resolve();

async function renderOnce(html) {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('No Chromium browser is installed for PDF downloads');
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pdf-'));
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir,
    // In a container the browser cannot use its own sandbox; the page has no JavaScript and no
    // network, which is what the sandbox would protect against here.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--font-render-hinting=none',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('data:') || url === 'about:blank') request.continue();
      else request.abort();
    });
    await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    return Buffer.from(
      await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        timeout: RENDER_TIMEOUT_MS,
      }),
    );
  } finally {
    await browser
      .close()
      .catch((error) => logger.warn({ err: error }, 'PDF browser did not close'));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The PDF of a complete HTML page (styles and pictures inside it).
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
export function renderPdf(html) {
  const result = queue.then(() => renderOnce(html));
  queue = result.catch(() => {});
  return result;
}
