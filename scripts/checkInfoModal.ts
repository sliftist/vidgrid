import { chromium } from "playwright";

const NAVIGATION_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 15_000;
const SETTLE_MS = 1500;
const DEMO_TITLE = "Inception (2010).mkv";
const TAB_LABELS = ["Overview", "Tracks", "Faces", "Keyframes", "Transcript", "Processing"];
const TEXT_PREVIEW_CHARS = 700;
const INSTALLED_BROWSER_CHANNEL = "msedge";

async function main(): Promise<void> {
    let baseUrl = process.argv[2];
    if (!baseUrl) {
        throw new Error("usage: yarn check-info-modal <base url of a served build-web folder>");
    }
    let browser = await chromium.launch({ headless: true, channel: INSTALLED_BROWSER_CHANNEL });
    let failures: string[] = [];
    try {
        let page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        page.on("pageerror", err => {
            failures.push(`page error: ${err.stack ?? err.message}`);
        });
        page.on("console", message => {
            if (message.type() === "error") {
                console.log(`[page console error] ${message.text()}`);
            }
        });
        await page.addInitScript(() => {
            let picker = async () => {
                let root = await navigator.storage.getDirectory();
                let handle = root as unknown as { queryPermission?: unknown; requestPermission?: unknown };
                handle.queryPermission = async () => "granted";
                handle.requestPermission = async () => "granted";
                return root;
            };
            (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = picker;
        });
        await page.goto(`${baseUrl}?demo=1`, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        let pickFolder = page.getByText("Pick Data Directory", { exact: false }).first();
        await pickFolder.waitFor({ timeout: STEP_TIMEOUT_MS });
        await pickFolder.click();
        let flatView = page.getByText("Flat", { exact: true }).first();
        await flatView.waitFor({ timeout: STEP_TIMEOUT_MS });
        await flatView.dispatchEvent("mousedown");
        await flatView.click();
        let cell = page.getByText(DEMO_TITLE, { exact: false }).first();
        try {
            await cell.waitFor({ timeout: STEP_TIMEOUT_MS });
        } catch (err) {
            let bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
            throw new Error(`the demo library never showed "${DEMO_TITLE}"; the page shows: ${bodyText.slice(0, TEXT_PREVIEW_CHARS * 2)}\n${(err as Error).stack}`);
        }
        await cell.hover();
        let infoButton = page.locator(`button[title="Show all info"]`).first();
        await infoButton.waitFor({ timeout: STEP_TIMEOUT_MS });
        await infoButton.click();
        let modal = page.locator(`[data-modal="1"]`).last();
        await modal.waitFor({ timeout: STEP_TIMEOUT_MS });
        for (let label of TAB_LABELS) {
            let tab = modal.locator("button", { hasText: label }).first();
            await tab.waitFor({ timeout: STEP_TIMEOUT_MS });
            await tab.dispatchEvent("mousedown");
            await page.waitForTimeout(SETTLE_MS);
            let text = (await modal.innerText()).replace(/\s+/g, " ");
            console.log(`--- ${label} tab (${text.length} chars): ${text.slice(0, TEXT_PREVIEW_CHARS)}`);
        }
        let transcriptTab = modal.locator("button", { hasText: "Transcript" }).first();
        await transcriptTab.dispatchEvent("mousedown");
        await page.waitForTimeout(SETTLE_MS);
        let transcriptText = (await modal.innerText()).replace(/\s+/g, " ");
        if (!transcriptText.includes("We leave at first light")) {
            failures.push(`transcript tab does not show the demo transcript; it shows: ${transcriptText.slice(0, TEXT_PREVIEW_CHARS)}`);
        }
        let search = modal.locator(`input[placeholder="Search this transcript"]`);
        await search.fill("lantern");
        await page.waitForTimeout(SETTLE_MS);
        let filteredText = (await modal.innerText()).replace(/\s+/g, " ");
        console.log(`--- Transcript tab filtered by "lantern": ${filteredText.slice(0, TEXT_PREVIEW_CHARS)}`);
        if (!filteredText.includes("1 of 10 lines match")) {
            failures.push(`filtering the transcript by "lantern" did not report 1 of 10 lines; it shows: ${filteredText.slice(0, TEXT_PREVIEW_CHARS)}`);
        }
        let line = modal.getByText("Keep the lantern covered", { exact: false }).first();
        await line.dispatchEvent("mousedown");
        await page.waitForTimeout(SETTLE_MS);
        console.log(`--- after clicking a transcript line the URL is ${page.url()} and the info modal is ${await page.locator(`[data-modal="1"]`).count() > 0 ? "still open" : "closed"}`);
    } finally {
        await browser.close();
    }
    if (failures.length > 0) {
        throw new Error(`info modal check failed:\n${failures.join("\n")}`);
    }
    console.log("info modal check passed");
}

main().then(() => process.exit(0), err => {
    console.error((err as Error).stack ?? err);
    process.exit(1);
});
