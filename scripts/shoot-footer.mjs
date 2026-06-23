import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  args: ['--hide-scrollbars'],
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5501/landing/index.html', { waitUntil: 'networkidle0' });
await page.addStyleTag({ content: '.reveal,.reveal *{opacity:1!important;transform:none!important;}' });
await page.evaluate(() => document.querySelector('.footer').scrollIntoView({ block: 'end' }));
await page.waitForFunction(() => {
  const img = document.querySelector('.footer-badge img');
  return img && img.complete && img.naturalWidth > 0;
}, { timeout: 10000 });
await new Promise(r => setTimeout(r, 400));
await (await page.$('.footer')).screenshot({ path: 'landing-shots/footer.png' });
await browser.close();
console.log('OK footer.png');
