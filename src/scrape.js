import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { dedupeJobs } from "./dedupe.js";
import { todayStamp, writeCsv } from "./writeCsv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BASE_SEARCH_URL =
  "https://www.dice.com/jobs?filters.postedDate=ONE&filters.employerType=Direct+Hire&filters.workplaceTypes=Remote&q=developer";

const PAGE_LOAD_TIMEOUT_MS = 60_000;
const MAX_PAGES = 50;
const DETAIL_CONCURRENCY = 4;

/**
 * @param {number} pageNum
 */
function searchUrlForPage(pageNum) {
  const url = new URL(BASE_SEARCH_URL);
  if (pageNum > 1) url.searchParams.set("page", String(pageNum));
  return url.toString();
}

/**
 * Absolute Dice URL from a possibly-relative href.
 * @param {string | null} href
 */
function toAbsoluteUrl(href) {
  if (!href) return "";
  try {
    return new URL(href, "https://www.dice.com").toString();
  } catch {
    return "";
  }
}

/**
 * @param {import('playwright').Page} page
 */
async function dismissOverlays(page) {
  const candidates = [
    page.locator("#onetrust-accept-btn-handler"),
    page.getByRole("button", { name: /accept all/i }),
    page.getByRole("button", { name: /accept/i }),
  ];
  for (const btn of candidates) {
    try {
      if (await btn.first().isVisible({ timeout: 1500 })) {
        await btn.first().click({ timeout: 2000 });
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Scroll the left results list so all cards on the page render.
 * @param {import('playwright').Page} page
 */
async function scrollJobList(page) {
  const list = page.locator('[data-testid="job-search-split-view-card-list-scroll"]');
  if ((await list.count()) === 0) return;

  for (let i = 0; i < 8; i++) {
    const before = await page.locator('[data-testid="job-card"]').count();
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(350);
    const after = await page.locator('[data-testid="job-card"]').count();
    if (after === before) break;
  }
}

/**
 * Extract jobs from search result cards (no description yet).
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ role: string, company: string, url: string }>>}
 */
async function extractJobsFromCards(page) {
  await scrollJobList(page);

  return page
    .evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="job-card"]')];
      const jobs = [];
      const seen = new Set();

      for (const card of cards) {
        const roleEl = card.querySelector('[data-testid="job-search-job-detail-link"]');
        const companyEl = card.querySelector('[data-testid="job-card-company-name"]');
        const linkEl =
          card.querySelector('[data-testid="job-search-job-card-link"]') ||
          card.querySelector('a[href*="/job-detail/"]');

        const role = (roleEl?.textContent || roleEl?.getAttribute("aria-label") || "")
          .trim()
          .replace(/\s+/g, " ");
        const company = (companyEl?.textContent || "").trim().replace(/\s+/g, " ");
        const href = linkEl?.getAttribute("href") || "";

        if (!role || !company || !href) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        jobs.push({ role, company, url: href });
      }

      return jobs;
    })
    .then((jobs) =>
      jobs.map((j) => ({
        ...j,
        url: toAbsoluteUrl(j.url),
        description: "",
      }))
    );
}

/**
 * @param {import('playwright').Page} page
 * @param {number} pageNum
 */
async function scrapeSearchPage(page, pageNum) {
  const url = searchUrlForPage(pageNum);
  console.log(`Opening page ${pageNum}: ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_LOAD_TIMEOUT_MS,
  });
  await dismissOverlays(page);

  await page
    .locator('[data-testid="job-card"]')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});

  await page.waitForTimeout(800);

  const jobs = await extractJobsFromCards(page);
  console.log(`Page ${pageNum}: collected ${jobs.length} jobs`);
  for (const job of jobs) {
    console.log(`  - ${job.role} @ ${job.company}`);
  }
  return jobs;
}

/**
 * Whether another results page exists.
 * @param {import('playwright').Page} page
 * @param {number} pageNum
 * @param {number} jobsOnPage
 */
async function hasNextPage(page, pageNum, jobsOnPage) {
  if (jobsOnPage === 0) return false;

  const nextBtn = page.locator(
    [
      'a[aria-label*="Next" i]',
      'button[aria-label*="Next" i]',
      '[data-testid*="pagination"] a[aria-label*="Next" i]',
      '[data-testid*="pagination"] button[aria-label*="Next" i]',
    ].join(", ")
  );

  try {
    if (await nextBtn.first().isVisible({ timeout: 1000 })) {
      const disabled =
        (await nextBtn.first().getAttribute("aria-disabled")) === "true" ||
        (await nextBtn.first().getAttribute("disabled")) !== null ||
        (await nextBtn.first().isDisabled().catch(() => false));
      if (!disabled) return true;
      return false;
    }
  } catch {
    // fall through to probe
  }

  const probe = await page.context().newPage();
  try {
    await probe.goto(searchUrlForPage(pageNum + 1), {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
    await probe.waitForTimeout(1200);
    const count = await probe.locator('[data-testid="job-card"]').count();
    return count > 0;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

/**
 * Fetch job description from the dedicated job-detail page.
 * @param {import('playwright').Page} page
 * @param {string} jobUrl
 * @returns {Promise<string>}
 */
async function fetchDescription(page, jobUrl) {
  await page.goto(jobUrl, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_LOAD_TIMEOUT_MS,
  });

  const descLocator = page.locator('[class*="jobDescription"]').first();
  await descLocator.waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const len = await descLocator
      .innerText()
      .then((t) => t.trim().length)
      .catch(() => 0);
    if (len > 40) break;
    await page.waitForTimeout(250);
  }

  const text = await descLocator.innerText().catch(() => "");
  return text
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Enrich jobs with descriptions, limited concurrency.
 * @param {import('playwright').BrowserContext} context
 * @param {Array<{ role: string, company: string, url: string, description?: string }>} jobs
 */
async function enrichWithDescriptions(context, jobs) {
  let nextIndex = 0;
  let completed = 0;

  async function worker(workerId) {
    const page = await context.newPage();
    try {
      while (true) {
        const i = nextIndex++;
        if (i >= jobs.length) break;
        const job = jobs[i];
        try {
          job.description = await fetchDescription(page, job.url);
          completed += 1;
          console.log(
            `[${completed}/${jobs.length}] ${job.role} @ ${job.company} (${job.description.length} chars)`
          );
        } catch (err) {
          job.description = "";
          completed += 1;
          console.warn(
            `[${completed}/${jobs.length}] Failed ${job.role}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } finally {
      await page.close();
    }
  }

  const workers = Array.from(
    { length: Math.min(DETAIL_CONCURRENCY, jobs.length) },
    (_, id) => worker(id)
  );
  await Promise.all(workers);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const allJobs = [];
  let pageNum = 1;

  try {
    while (pageNum <= MAX_PAGES) {
      const pageJobs = await scrapeSearchPage(page, pageNum);
      if (pageJobs.length === 0) break;

      allJobs.push(...pageJobs);

      const more = await hasNextPage(page, pageNum, pageJobs.length);
      if (!more) break;
      pageNum += 1;
    }

    await page.close();

    const unique = dedupeJobs(allJobs);
    console.log(
      `Collected ${allJobs.length} rows, ${unique.length} unique — fetching descriptions…`
    );

    await enrichWithDescriptions(context, unique);

    const stamp = todayStamp();
    const outPath = path.join(ROOT, "output", `jobs-${stamp}.csv`);
    writeCsv(unique, outPath);

    const withDesc = unique.filter((j) => j.description).length;
    console.log(
      `Scraped ${allJobs.length} rows, ${unique.length} unique jobs for ${stamp} (${withDesc} with description)`
    );
    console.log(`Wrote ${outPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
