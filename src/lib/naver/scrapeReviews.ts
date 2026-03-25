import { chromium, type Browser, type Page, type Response } from "playwright";
import { NaverReview } from "./types";

const DEFAULT_LOCAL_CDP_ENDPOINT = "http://127.0.0.1:9222";
const RUNNING_ON_CLOUD_RUN = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);
const CDP_ENDPOINT = process.env.CHROME_CDP_URL?.trim() || (
  RUNNING_ON_CLOUD_RUN ? undefined : DEFAULT_LOCAL_CDP_ENDPOINT
);
const CHROMIUM_COMMON_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
];
const CHROMIUM_CONTAINER_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];
const MAX_ITERATIONS = 60;
const ACCESS_DENIED_MESSAGE = RUNNING_ON_CLOUD_RUN
  ? "ACCESS_DENIED: 네이버 스마트스토어 접근이 차단되었습니다. Cloud Run headless 환경은 차단될 수 있으므로 가능하면 CHROME_CDP_URL로 원격 Chrome/CDP 엔드포인트를 연결하세요."
  : "ACCESS_DENIED: 네이버 스마트스토어 접근이 차단되었습니다. Chrome을 --remote-debugging-port=9222 로 실행한 뒤 재시도하세요.";

type JsonRecord = Record<string, unknown>;

interface DomReviewCandidate {
  reviewId?: string;
  rating?: number | null;
  authorName?: string | null;
  headline?: string | null;
  content?: string | null;
  optionInfo?: string | null;
  createdAt?: string | null;
  helpfulCount?: number | null;
  imageUrls?: string[];
}

interface ProductDetailsResponse {
  productNo?: string;
  productName?: string;
  channel?: {
    naverPaySellerNo?: string | number;
  };
}

interface ProductSummaryReviewItem {
  id?: string | number;
  reviewScore?: number | string;
  reviewContent?: string;
  createDate?: string;
  maskedWriterId?: string;
  productOptionContent?: string;
  reviewAttach?: {
    representAttach?: {
      attachPath?: string;
    };
    attaches?: Array<{
      attachPath?: string;
    }>;
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

const FORCE_HEADLESS = RUNNING_ON_CLOUD_RUN || isTruthyEnv(process.env.PLAYWRIGHT_HEADLESS);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = normalizeWhitespace(stripTags(decodeHtml(value)));
  return cleaned || undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function pickValue(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function flattenImageUrls(value: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const pushUrl = (raw: unknown) => {
    const maybeUrl = asString(raw);
    if (!maybeUrl) {
      return;
    }
    if (!/^https?:\/\//i.test(maybeUrl) && !maybeUrl.startsWith("//")) {
      return;
    }
    const normalized = maybeUrl.startsWith("//") ? `https:${maybeUrl}` : maybeUrl;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  };

  const walk = (current: unknown) => {
    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item);
      }
      return;
    }
    if (isRecord(current)) {
      for (const [key, nested] of Object.entries(current)) {
        if (key.toLowerCase().includes("url") || key.toLowerCase().includes("src")) {
          pushUrl(nested);
        } else {
          walk(nested);
        }
      }
      return;
    }
    pushUrl(current);
  };

  walk(value);
  return urls;
}

function normalizeRating(value: unknown): number | null {
  const rating = asNumber(value);
  if (rating === undefined) {
    return null;
  }
  if (rating >= 0 && rating <= 5) {
    return Number(rating.toFixed(1));
  }
  if (rating >= 10 && rating <= 50) {
    return Number((rating / 10).toFixed(1));
  }
  return null;
}

function sanitizeReview(review: NaverReview, productId: string, productName?: string): NaverReview | null {
  const imageUrls = flattenImageUrls(review.imageUrls ?? []);
  const normalized: NaverReview = {
    productId,
    productName,
    reviewId: asString(review.reviewId),
    rating: normalizeRating(review.rating ?? null),
    authorName: cleanText(review.authorName),
    headline: cleanText(review.headline),
    content: cleanText(review.content),
    optionInfo: cleanText(review.optionInfo),
    createdAt: cleanText(review.createdAt),
    helpfulCount: asNumber(review.helpfulCount) ?? 0,
    imageUrls,
  };

  const hasMeaningfulSignal =
    Boolean(normalized.reviewId) ||
    normalized.rating !== null ||
    Boolean(normalized.authorName) ||
    Boolean(normalized.headline) ||
    Boolean(normalized.content) ||
    Boolean(normalized.optionInfo) ||
    Boolean(normalized.createdAt) ||
    imageUrls.length > 0;

  if (!hasMeaningfulSignal) {
    return null;
  }

  normalized.hasPhoto = imageUrls.length > 0;
  return normalized;
}

function looksLikeReviewRecord(record: JsonRecord): boolean {
  const textLike = [
    "content",
    "reviewContent",
    "body",
    "reviewText",
    "reviewCont",
    "contents",
    "title",
    "headline",
  ];
  const ratingLike = ["rating", "score", "starScore", "reviewScore"];
  const identityLike = ["reviewId", "reviewNo", "id", "seq"];
  const dateLike = ["createdAt", "createDate", "registerDate", "writtenAt"];

  const hasText = textLike.some((key) => cleanText(record[key]));
  const hasRating = ratingLike.some((key) => asNumber(record[key]) !== undefined);
  const hasIdentity = identityLike.some((key) => asString(record[key]));
  const hasDate = dateLike.some((key) => cleanText(record[key]));

  return hasText && (hasRating || hasIdentity || hasDate);
}

function collectReviewRecords(payload: unknown): JsonRecord[] {
  const collected: JsonRecord[] = [];

  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    if (!isRecord(value)) {
      return;
    }

    if (looksLikeReviewRecord(value)) {
      collected.push(value);
    }

    for (const nested of Object.values(value)) {
      walk(nested);
    }
  };

  walk(payload);
  return collected;
}

function extractReviewFromRecord(
  record: JsonRecord,
  productId: string,
  productName?: string
): NaverReview | null {
  const review: NaverReview = {
    productId,
    productName,
    reviewId: asString(pickValue(record, ["reviewId", "reviewNo", "id", "seq", "reviewSeq"])),
    rating: normalizeRating(pickValue(record, ["rating", "score", "starScore", "reviewScore"])),
    authorName: cleanText(
      pickValue(record, ["authorName", "writerName", "memberMaskedId", "userName", "nickname"])
    ),
    headline: cleanText(pickValue(record, ["headline", "title", "reviewTitle", "subject"])),
    content: cleanText(
      pickValue(record, ["content", "reviewContent", "body", "reviewText", "contents", "reviewCont"])
    ),
    optionInfo: cleanText(
      pickValue(record, ["optionInfo", "productOption", "optionName", "itemOption", "purchaseOption"])
    ),
    createdAt: cleanText(
      pickValue(record, ["createdAt", "createDate", "registerDate", "writtenAt", "reviewCreatedDate"])
    ),
    helpfulCount: asNumber(pickValue(record, ["helpfulCount", "helpCount", "recommendCount", "likeCount"])),
    imageUrls: flattenImageUrls(
      pickValue(record, ["imageUrls", "images", "photoList", "photos", "reviewImages"])
    ),
  };

  return sanitizeReview(review, productId, productName);
}

function extractReviewsFromPayload(
  payload: unknown,
  productId: string,
  productName?: string
): NaverReview[] {
  const records = collectReviewRecords(payload);
  const reviews: NaverReview[] = [];
  const dedupeKeys = new Set<string>();

  for (const record of records) {
    const review = extractReviewFromRecord(record, productId, productName);
    if (!review) {
      continue;
    }
    const key = review.reviewId
      ? `id:${review.reviewId}`
      : `combo:${review.rating}|${review.authorName}|${review.createdAt}|${review.content}`;
    if (dedupeKeys.has(key)) {
      continue;
    }
    dedupeKeys.add(key);
    reviews.push(review);
  }

  return reviews;
}

async function extractReviewsFromDom(
  page: Page,
  productId: string,
  productName?: string
): Promise<NaverReview[]> {
  const rawCandidates = await page.evaluate<DomReviewCandidate[]>(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

    const parseRating = (target: Element): number | null => {
      const ratingSource =
        target.getAttribute("aria-label") ||
        target.querySelector('[aria-label*="평점"], [aria-label*="별점"]')?.getAttribute("aria-label") ||
        (target.textContent ?? "");

      const text = normalize(ratingSource);
      const labelMatch = text.match(/(?:평점|별점)\s*([0-5](?:[.,]\d)?)/);
      if (labelMatch) {
        return Number.parseFloat(labelMatch[1].replace(",", "."));
      }
      const plainMatch = text.match(/([0-5](?:[.,]\d)?)/);
      if (plainMatch) {
        return Number.parseFloat(plainMatch[1].replace(",", "."));
      }
      return null;
    };

    const candidates = new Set<Element>();
    const selectors = [
      '[data-review-id]',
      '[data-review-no]',
      'article[class*="review"]',
      'li[class*="review"]',
      '[class*="review"] li',
      '[class*="review"] article',
      '[id*="REVIEW"] li',
      '[id*="review"] li',
    ];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        candidates.add(element);
      }
    }

    for (const ratingElement of document.querySelectorAll('[aria-label*="평점"], [aria-label*="별점"]')) {
      const container = ratingElement.closest("li, article, div");
      if (container) {
        candidates.add(container);
      }
    }

    const reviews: DomReviewCandidate[] = [];
    const dedupe = new Set<string>();

    for (const candidate of candidates) {
      const text = normalize(candidate.textContent ?? "");
      if (text.length < 15) {
        continue;
      }

      const contentElement =
        candidate.querySelector('[class*="content"]') ||
        candidate.querySelector('[class*="text"]') ||
        candidate.querySelector("p");
      const titleElement = candidate.querySelector('[class*="title"], [class*="headline"], strong');
      const optionElement = candidate.querySelector('[class*="option"]');
      const authorElement = candidate.querySelector(
        '[class*="name"], [class*="writer"], [class*="user"], [class*="profile"]'
      );
      const dateElement = candidate.querySelector('[class*="date"], time');

      const content = normalize(contentElement?.textContent ?? "");
      const headline = normalize(titleElement?.textContent ?? "");
      if (!content && !headline) {
        continue;
      }

      const reviewId =
        candidate.getAttribute("data-review-id") ||
        candidate.getAttribute("data-review-no") ||
        candidate.getAttribute("data-review-seq") ||
        undefined;

      const rating = parseRating(candidate);
      const createdAt =
        normalize(dateElement?.textContent ?? "") ||
        text.match(/\d{2,4}[./-]\d{1,2}[./-]\d{1,2}/)?.[0] ||
        undefined;
      const helpfulText =
        candidate.querySelector('[class*="help"], [class*="recommend"], [class*="like"]')?.textContent || text;
      const helpfulCount = Number.parseInt(
        (helpfulText.match(/(?:도움|추천|좋아요)\D*([0-9]+)/)?.[1] ?? "0"),
        10
      );

      const imageUrls = Array.from(candidate.querySelectorAll("img"))
        .map((img) => img.getAttribute("src") || img.getAttribute("data-src"))
        .filter((value): value is string => Boolean(value))
        .map((value) => (value.startsWith("//") ? `https:${value}` : value))
        .filter((value) => /^https?:\/\//i.test(value) && !value.startsWith("data:image"));

      const hasReviewSignal = Boolean(
        reviewId ||
          rating !== null ||
          createdAt ||
          normalize(authorElement?.textContent ?? "") ||
          headline ||
          content ||
          imageUrls.length > 0 ||
          candidate.querySelector('[class*="star"], [class*="rating"]')
      );
      if (!hasReviewSignal) {
        continue;
      }

      const dedupeKey = reviewId || `${headline}|${content}|${createdAt}`;
      if (dedupe.has(dedupeKey)) {
        continue;
      }
      dedupe.add(dedupeKey);

      reviews.push({
        reviewId,
        rating,
        authorName: normalize(authorElement?.textContent ?? "") || undefined,
        headline: headline || undefined,
        content: content || undefined,
        optionInfo: normalize(optionElement?.textContent ?? "") || undefined,
        createdAt: createdAt || undefined,
        helpfulCount: Number.isNaN(helpfulCount) ? 0 : helpfulCount,
        imageUrls,
      });
    }

    return reviews;
  });

  const results: NaverReview[] = [];
  for (const candidate of rawCandidates) {
    const sanitized = sanitizeReview(
      {
        productId,
        productName,
        reviewId: candidate.reviewId,
        rating: candidate.rating,
        authorName: candidate.authorName,
        headline: candidate.headline,
        content: candidate.content,
        optionInfo: candidate.optionInfo,
        createdAt: candidate.createdAt,
        helpfulCount: candidate.helpfulCount,
        imageUrls: candidate.imageUrls,
      },
      productId,
      productName
    );
    if (sanitized) {
      results.push(sanitized);
    }
  }

  return results;
}

async function openReviewTab(page: Page): Promise<void> {
  const selectors = [
    '[role="tab"]:has-text("리뷰")',
    'button:has-text("리뷰")',
    'a:has-text("리뷰")',
    '[data-shp-area-id*="review"]',
    'li:has-text("리뷰")',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      continue;
    }

    try {
      await locator.click({ timeout: 4_000 });
      await sleep(1_200);
      return;
    } catch {
      continue;
    }
  }

  const clickedByText = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("button, a, li, div[role='tab']"));
    const target = elements.find((element) => {
      const text = (element.textContent ?? "").replace(/\s+/g, "");
      if (!text.includes("리뷰")) {
        return false;
      }
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      return true;
    });

    if (!target) {
      return false;
    }

    (target as HTMLElement).click();
    return true;
  });

  if (clickedByText) {
    await sleep(1_200);
  }
}

async function goToNextReviewChunk(page: Page): Promise<boolean> {
  const selectors = [
    'button:has-text("더보기")',
    'a:has-text("더보기")',
    'button:has-text("다음")',
    'a:has-text("다음")',
    '[aria-label*="다음"]',
    '[class*="next"] button',
    '[class*="pagination"] button:last-child',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      continue;
    }

    try {
      await locator.click({ timeout: 4_000 });
      await sleep(1_100);
      return true;
    } catch {
      continue;
    }
  }

  return page.evaluate(() => {
    const targets = Array.from(document.querySelectorAll("button, a"));
    for (const element of targets) {
      const text = (element.textContent ?? "").replace(/\s+/g, "");
      if (!text || (!text.includes("더보기") && !text.includes("다음"))) {
        continue;
      }
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }
      if (
        (element as HTMLButtonElement).disabled ||
        element.getAttribute("aria-disabled") === "true"
      ) {
        continue;
      }

      htmlElement.click();
      return true;
    }
    return false;
  });
}

async function flushPendingTasks(tasks: Promise<void>[]) {
  if (tasks.length === 0) {
    return;
  }
  const current = tasks.splice(0, tasks.length);
  const settled = await Promise.allSettled(current);
  for (const result of settled) {
    if (result.status === "rejected") {
      console.warn("[scrapeNaverReviews] response parsing task failed:", result.reason);
    }
  }
}

async function extractReviewsFromResponse(
  response: Response,
  productId: string,
  productName?: string
): Promise<NaverReview[]> {
  const url = response.url().toLowerCase();
  if (!url.includes("review")) {
    return [];
  }

  const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
  try {
    if (contentType.includes("json")) {
      const json = await response.json();
      return extractReviewsFromPayload(json, productId, productName);
    }

    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) {
      return [];
    }

    const possibleJson = trimmed.replace(/^\)\]\}',?\s*/, "");
    try {
      const parsed = JSON.parse(possibleJson) as unknown;
      return extractReviewsFromPayload(parsed, productId, productName);
    } catch {
      return [];
    }
  } catch (error) {
    console.warn("[scrapeNaverReviews] review response parse 실패:", error);
    return [];
  }
}

async function connectBrowser(): Promise<{ browser: Browser; ownsBrowser: boolean }> {
  if (CDP_ENDPOINT) {
    try {
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
      console.log("[browser:naver] CDP 연결 성공:", CDP_ENDPOINT);
      return { browser, ownsBrowser: false };
    } catch {
      console.log("[browser:naver] CDP 연결 실패, Playwright launch로 전환");
    }
  }

  if (!FORCE_HEADLESS) {
    try {
      const browser = await chromium.launch({
        headless: false,
        channel: "chrome",
        args: [...CHROMIUM_COMMON_ARGS, "--window-position=-2000,-2000", "--window-size=1,1"],
      });
      console.log("[browser:naver] system Chrome (headed) 실행 성공");
      return { browser, ownsBrowser: true };
    } catch {
      console.log("[browser:naver] system Chrome 없음 또는 실행 실패, headless Chromium으로 전환");
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: [...CHROMIUM_COMMON_ARGS, ...CHROMIUM_CONTAINER_ARGS],
  });
  console.log(
    FORCE_HEADLESS
      ? "[browser:naver] headless Chromium 실행 (Cloud Run/헤드리스 환경)"
      : "[browser:naver] headless Chromium 실행 (차단 가능성 있음)"
  );
  return { browser, ownsBrowser: true };
}

async function extractProductName(page: Page): Promise<string | undefined> {
  const candidates = [
    "h1",
    '[data-shp-area-id*="product_name"]',
    '[class*="product"] h1',
    '[class*="Product"] h1',
  ];

  for (const selector of candidates) {
    const text = await page.textContent(selector).catch(() => null);
    const cleaned = cleanText(text);
    if (cleaned) {
      return cleaned;
    }
  }

  const ogTitle = await page.getAttribute('meta[property="og:title"]', "content").catch(() => null);
  const normalizedOg = cleanText(ogTitle);
  if (normalizedOg) {
    return normalizedOg.replace(/\s*\|.*$/, "");
  }

  return undefined;
}

function appendReviews(
  source: NaverReview[],
  destination: NaverReview[],
  dedupeKeys: Set<string>,
  limit: number
) {
  for (const review of source) {
    if (destination.length >= limit) {
      return;
    }
    const key = review.reviewId
      ? `id:${review.reviewId}`
      : `combo:${review.rating}|${review.authorName}|${review.createdAt}|${review.content}`;
    if (dedupeKeys.has(key)) {
      continue;
    }
    dedupeKeys.add(key);
    destination.push(review);
  }
}

function extractProductSummaryReview(review: ProductSummaryReviewItem, productId: string, productName?: string): NaverReview | null {
  const imageUrls = [
    review.reviewAttach?.representAttach?.attachPath,
    ...(review.reviewAttach?.attaches?.map((attach) => attach.attachPath) ?? []),
  ].filter((value): value is string => Boolean(value));

  return sanitizeReview(
    {
      productId,
      productName,
      reviewId: asString(review.id),
      rating: normalizeRating(review.reviewScore),
      authorName: review.maskedWriterId,
      headline: undefined,
      content: review.reviewContent,
      optionInfo: review.productOptionContent,
      createdAt: review.createDate,
      helpfulCount: 0,
      imageUrls,
    },
    productId,
    productName
  );
}

async function fetchProductDetails(page: Page, productPageUrl: string): Promise<ProductDetailsResponse> {
  const responsePromise = page.waitForResponse((response) => {
    const url = response.url();
    return url.includes("/products/") && url.includes("?withWindow=false");
  });

  await page.goto(productPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const response = await responsePromise;
  return (await response.json()) as ProductDetailsResponse;
}

async function fetchProductSummaryReviews(
  page: Page,
  productNo: string,
  checkoutMerchantNo: string,
  limit: number
): Promise<NaverReview[]> {
  const reviews = await page.evaluate(
    async ({ productNo, checkoutMerchantNo }) => {
      const url = new URL(`/n/v1/contents/reviews/product-summary/${productNo}/reviews/GENERAL`, window.location.origin);
      url.searchParams.set("checkoutMerchantNo", checkoutMerchantNo);
      url.searchParams.set("searchSortType", "REVIEW_CREATE_DATE_DESC");

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, */*",
          "x-client-version": "20260320164531",
        },
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP_${response.status}`);
      }

      return response.json();
    },
    { productNo, checkoutMerchantNo }
  );

  const contents = Array.isArray((reviews as { contents?: unknown }).contents)
    ? ((reviews as { contents?: ProductSummaryReviewItem[] }).contents ?? [])
    : [];

  return contents
    .map((review) => extractProductSummaryReview(review, productNo))
    .filter((review): review is NaverReview => Boolean(review))
    .slice(0, limit);
}

export async function scrapeNaverReviews(params: {
  url: string;
  productId: string;
  limit: number;
}): Promise<NaverReview[]> {
  const { url, productId, limit } = params;
  const { browser, ownsBrowser } = await connectBrowser();

  try {
    const contexts = browser.contexts();
    const context =
      contexts.length > 0
        ? contexts[0]
        : await browser.newContext({
            locale: "ko-KR",
            viewport: { width: 1280, height: 720 },
          });
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const reviews: NaverReview[] = [];
    const dedupeKeys = new Set<string>();
    const responseTasks: Promise<void>[] = [];
    let productName: string | undefined;
    let internalProductNo: string | undefined;
    let checkoutMerchantNo: string | undefined;

    page.on("response", (response) => {
      const task = (async () => {
        const parsed = await extractReviewsFromResponse(response, productId, productName);
        appendReviews(parsed, reviews, dedupeKeys, limit);
      })();
      responseTasks.push(task);
    });

    console.log(`[scrapeNaverReviews] 상품 페이지 방문 중: ${url}`);
    const productDetails = await fetchProductDetails(page, url);
    await sleep(2_000);

    const pageTitle = await page.title();
    if (pageTitle.includes("Access Denied")) {
      throw new Error(ACCESS_DENIED_MESSAGE);
    }

    productName = await extractProductName(page);
    internalProductNo = asString(productDetails.productNo);
    checkoutMerchantNo = asString(productDetails.channel?.naverPaySellerNo);
    console.log(`[scrapeNaverReviews] productName=${productName || "(없음)"}`);
    console.log(
      `[scrapeNaverReviews] internalProductNo=${internalProductNo || "(없음)"}, checkoutMerchantNo=${checkoutMerchantNo || "(없음)"}`
    );

    if (internalProductNo && checkoutMerchantNo) {
      try {
        const apiReviews = await fetchProductSummaryReviews(
          page,
          internalProductNo,
          checkoutMerchantNo,
          limit
        );
        appendReviews(apiReviews, reviews, dedupeKeys, limit);
        console.log(`[scrapeNaverReviews] API 수집: ${reviews.length}개`);
      } catch (error) {
        console.warn("[scrapeNaverReviews] review summary API 실패:", error);
      }
    }

    if (reviews.length === 0) {
      await openReviewTab(page);
      await flushPendingTasks(responseTasks);

      let previousCount = reviews.length;
      let stagnantCount = 0;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        if (reviews.length >= limit) {
          break;
        }

        const domReviews = await extractReviewsFromDom(page, productId, productName);
        appendReviews(domReviews, reviews, dedupeKeys, limit);
        await flushPendingTasks(responseTasks);

        if (reviews.length >= limit) {
          break;
        }

        const moved = await goToNextReviewChunk(page);
        if (!moved) {
          break;
        }

        await sleep(700 + Math.floor(Math.random() * 400));
        await flushPendingTasks(responseTasks);

        if (reviews.length === previousCount) {
          stagnantCount += 1;
        } else {
          stagnantCount = 0;
          previousCount = reviews.length;
        }

        if (stagnantCount >= 4) {
          break;
        }
      }
    }

    await flushPendingTasks(responseTasks);
    await page.close();

    console.log(`[scrapeNaverReviews] productId=${productId}, 수집 완료: ${reviews.length}개`);
    if (reviews.length === 0) {
      throw new Error("PARSE_FAILED: 리뷰를 찾지 못했습니다.");
    }

    return reviews.slice(0, limit).map((review) => ({
      ...review,
      productName: review.productName ?? productName,
    }));
  } finally {
    if (ownsBrowser) {
      await browser.close();
    }
  }
}
