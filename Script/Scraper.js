const { chromium } = require('playwright');
const fs = require('fs');

async function runScraper() {
    // Launch the browser. Set headless: false if you want to watch it work visually!
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('Navigating to website...');
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

        // Example: Extracting data using Playwright's locator system
        // Replace 'h1' with the actual CSS selector of the data you want
        const headingText = await page.locator('h1').textContent();
        
        console.log('Scraped Heading:', headingText);

        // Save data to a JSON file
        const scrapedData = { heading: headingText, timestamp: new Date() };
        fs.writeFileSync('data.json', JSON.stringify(scrapedData, null, 2));
        console.log('Data saved successfully to data.json!');

    } catch (error) {
        console.error('An error occurred during scraping:', error);
    } finally {
        await browser.close();
    }
}

runScraper();