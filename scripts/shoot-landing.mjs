import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const URL = 'http://127.0.0.1:5501/landing/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'landing-shots';
mkdirSync(OUT, { recursive: true });

// [filename, selector] — order = listing order
const SHOTS = [
  ['01-hero',     '.hero'],
  ['02-story',    '#story'],
  ['03-fleet',    '#fleet'],
  ['04-security', '#security'],
  ['05-features', '#features'],
  ['06-what',     '#what'],
  ['07-cost',     '#cost'],
  ['08-how',      '#how'],
  ['09-desktop',  '#desktop'],
  ['10-compare',  '#compare'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  args: ['--hide-scrollbars', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });

// GSAP keeps .reveal elements at opacity:0 until scrolled into view; force them
// all visible so element screenshots aren't blank.
await page.addStyleTag({
  content: `.reveal, .reveal * { opacity: 1 !important; transform: none !important;
    clip-path: none !important; filter: none !important; visibility: visible !important; }`,
});

// Trigger any scroll-reveal animations by scrolling through the whole page.
await page.evaluate(async () => {
  const h = document.body.scrollHeight;
  for (let y = 0; y < h; y += 400) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  window.scrollTo(0, 0);
});
await sleep(800);

for (const [name, sel] of SHOTS) {
  const found = await page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.scrollIntoView({ block: 'start' });
    return true;
  }, sel);
  if (!found) { console.log(`MISS  ${sel}`); continue; }
  await sleep(600); // let reveals settle
  const el = await page.$(sel);
  await el.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`OK    ${name}.png  (${sel})`);
}

await browser.close();
console.log('\nDone →', OUT);
