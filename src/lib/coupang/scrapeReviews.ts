import { chromium, type Browser, type Page } from "playwright";
import { CoupangReview } from "./types";

const REVIEWS_PER_PAGE = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeHtml(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** 단일 리뷰 article HTML에서 데이터 추출 */
function parseReviewArticle(articleHtml: string, productId: string): CoupangReview | null {
  try {
    const ratingMatch = articleHtml.match(/data-rating="(\d)"/);
    const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : null;

    const authorMatch = articleHtml.match(
      /sdp-review__article__list__info__user__name[^>]*>([^<]+)</
    );
    const authorName = authorMatch ? decodeHtml(authorMatch[1]).trim() : null;

    const dateMatch = articleHtml.match(
      /sdp-review__article__list__info__product-info__reg-date[^>]*>([^<]+)</
    );
    const createdAt = dateMatch ? decodeHtml(dateMatch[1]).trim() : null;

    const headlineMatch = articleHtml.match(
      /sdp-review__article__list__review__headline[^>]*>([\s\S]*?)<\/div>/
    );
    const headline = headlineMatch ? stripTags(decodeHtml(headlineMatch[1])).trim() || null : null;

    const contentMatch = articleHtml.match(
      /sdp-review__article__list__review__content[^>]*>([\s\S]*?)<\/div>/
    );
    const content = contentMatch ? stripTags(decodeHtml(contentMatch[1])).trim() || null : null;

    const optionMatch = articleHtml.match(
      /sdp-review__article__list__info__product-info__option[^>]*>([\s\S]*?)<\/div>/
    );
    const optionInfo = optionMatch ? stripTags(decodeHtml(optionMatch[1])).trim() || null : null;

    const helpfulMatch = articleHtml.match(
      /sdp-review__article__list__help__count[^>]*>(\d+)/
    );
    const helpfulCount = helpfulMatch ? parseInt(helpfulMatch[1], 10) : 0;

    const imageUrls: string[] = [];
    const imgRegex = /sdp-review__article__list__attachment__list__item[^>]*>[\s\S]*?(?:src|data-src)="([^"]+)"/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(articleHtml)) !== null) {
      const url = imgMatch[1];
      if (url && !url.includes("placeholder")) {
        imageUrls.push(url.startsWith("//") ? `https:${url}` : url);
      }
    }

    const reviewIdMatch = articleHtml.match(/data-review-seq="(\d+)"/);
    const reviewId = reviewIdMatch ? reviewIdMatch[1] : undefined;

    return {
      productId,
      reviewId,
      rating,
      authorName,
      headline,
      content,
      optionInfo,
      createdAt,
      helpfulCount,
      hasPhoto: imageUrls.length > 0,
      imageUrls,
    };
  } catch {
    return null;
  }
}

/** HTML 응답에서 개별 리뷰 article을 분리 */
function splitReviewArticles(html: string): string[] {
  const articles: string[] = [];
  const regex = /<article\s+class="[^"]*sdp-review__article__list[^"]*"[\s\S]*?<\/article>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    articles.push(match[0]);
  }
  return articles;
}

/**
 * 브라우저 내부에서 리뷰 API를 XHR로 호출한다.
 * same-origin이므로 쿠키/세션이 자동으로 포함된다.
 */
async function fetchReviewPageViaXHR(
  page: Page,
  productId: string,
  pageNum: number
): Promise<string> {
  return page.evaluate(
    async ({ productId, pageNum }) => {
      const url = new URL("/vp/product/reviews", window.location.origin);
      url.searchParams.set("productId", productId);
      url.searchParams.set("page", String(pageNum));
      url.searchParams.set("size", "5");
      url.searchParams.set("sortBy", "ORDER_SCORE_ASC");
      url.searchParams.set("ratings", "");
      url.searchParams.set("q", "");
      url.searchParams.set("viRoleCode", "2");
      url.searchParams.set("ratingSummary", "false");

      const res = await fetch(url.toString(), {
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      return res.text();
    },
    { productId, pageNum }
  );
}

/**
 * Playwright 브라우저를 실행한다.
 *
 * 쿠팡은 Akamai Bot Manager를 사용하여 자동화 도구를 감지한다.
 * - headless Chromium: 차단됨
 * - headless system Chrome: 차단됨
 * - headed system Chrome: 통과
 *
 * 따라서 시스템에 설치된 Chrome을 headed 모드로 실행한다.
 * macOS에서는 Chrome 창이 잠깐 열렸다 닫힌다.
 * 서버 환경에서는 Xvfb를 사용하거나, 프록시/쿠키 방식을 고려해야 한다.
 */
async function launchBrowser(): Promise<Browser> {
  // 1순위: system Chrome (headed) — Akamai 우회 가능
  try {
    return await chromium.launch({
      headless: false,
      channel: "chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--window-position=-2000,-2000", // 화면 밖에 배치
        "--window-size=1,1",
      ],
    });
  } catch {
    // system Chrome이 없는 경우
  }

  // 2순위: headless Chromium (Akamai에 차단될 수 있음)
  return chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });
}

/**
 * 쿠팡 상품 리뷰를 수집한다.
 *
 * 동작 흐름:
 * 1. Playwright로 상품 페이지 방문 (브라우저 세션/쿠키 자동 획득)
 * 2. 페이지 내에서 리뷰 API를 XHR로 호출 (same-origin → 쿠키 자동 포함)
 * 3. 반환된 HTML fragment에서 리뷰 데이터 파싱
 * 4. XHR 실패 시 DOM에서 직접 파싱 (fallback)
 *
 * @throws Error ACCESS_DENIED — 쿠팡이 접근을 차단한 경우
 * @throws Error PARSE_FAILED — 페이지 구조가 예상과 다른 경우
 */
export async function scrapeCoupangReviews(params: {
  url: string;
  productId: string;
  limit: number;
}): Promise<CoupangReview[]> {
  const { url, productId, limit } = params;

  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({
      locale: "ko-KR",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    // navigator.webdriver 속성 제거
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // 1단계: 상품 페이지 방문
    console.log(`[scrapeReviews] 상품 페이지 방문 중: ${url}`);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await sleep(2000);

    // 접근 차단 감지
    const title = await page.title();
    if (title.includes("Access Denied")) {
      throw new Error("ACCESS_DENIED: 쿠팡이 접근을 차단했습니다.");
    }

    // 상품명 추출
    let productName: string | undefined;
    try {
      productName =
        (await page.textContent("h1.prod-buy-header__title"))?.trim() ??
        (await page.getAttribute('meta[property="og:title"]', "content"))?.trim() ??
        undefined;
    } catch {
      // 상품명 추출 실패는 무시
    }
    console.log(`[scrapeReviews] productName=${productName || "(없음)"}`);

    // 리뷰 탭 클릭 시도
    try {
      const reviewTab = page.locator('a[href*="btm_reviews"], li[data-tab="btm_reviews"]');
      if ((await reviewTab.count()) > 0) {
        await reviewTab.first().click();
        await sleep(1500);
      }
    } catch {
      // 리뷰 탭이 없으면 무시
    }

    // 2단계: XHR로 리뷰 수집
    const reviews: CoupangReview[] = [];
    const seenIds = new Set<string>();
    const maxPages = Math.ceil(limit / REVIEWS_PER_PAGE) + 2;
    let consecutiveFailures = 0;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (reviews.length >= limit) break;

      try {
        const html = await fetchReviewPageViaXHR(page, productId, pageNum);
        const articles = splitReviewArticles(html);

        if (articles.length === 0) {
          console.log(`[scrapeReviews] page ${pageNum}: 리뷰 0개, 종료`);
          break;
        }

        consecutiveFailures = 0;

        for (const articleHtml of articles) {
          if (reviews.length >= limit) break;

          const review = parseReviewArticle(articleHtml, productId);
          if (!review) continue;

          review.productName = productName;

          // 중복 제거
          const dedupeKey = review.reviewId
            ? `id:${review.reviewId}`
            : `combo:${review.rating}|${review.authorName}|${review.content}|${review.createdAt}`;

          if (seenIds.has(dedupeKey)) continue;
          seenIds.add(dedupeKey);

          reviews.push(review);
        }

        console.log(
          `[scrapeReviews] page ${pageNum}: ${articles.length}개 article, 누적 ${reviews.length}개`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[scrapeReviews] page ${pageNum} XHR 실패: ${msg}`);
        consecutiveFailures++;

        // 403이 연속 발생하면 접근 차단으로 판단
        if (msg.includes("HTTP_403") && consecutiveFailures >= 2) {
          console.warn("[scrapeReviews] 리뷰 API 접근 차단 감지");
          break;
        }
        if (consecutiveFailures >= 3) break;
        continue;
      }

      // 요청 간 딜레이 (봇 감지 방지)
      if (reviews.length < limit) {
        await sleep(400 + Math.random() * 300);
      }
    }

    // 3단계: XHR 실패 시 DOM에서 직접 파싱 (fallback)
    if (reviews.length === 0) {
      console.log("[scrapeReviews] XHR 수집 실패, DOM 파싱 fallback 시도");
      try {
        await page.waitForSelector("article.sdp-review__article__list", {
          timeout: 10_000,
        });
        const fullHtml = await page.content();
        const articles = splitReviewArticles(fullHtml);

        for (const articleHtml of articles) {
          if (reviews.length >= limit) break;

          const review = parseReviewArticle(articleHtml, productId);
          if (!review) continue;

          review.productName = productName;
          reviews.push(review);
        }
        console.log(`[scrapeReviews] DOM fallback: ${reviews.length}개 수집`);
      } catch {
        console.log("[scrapeReviews] DOM에서도 리뷰를 찾을 수 없음");
      }
    }

    console.log(`[scrapeReviews] productId=${productId}, 수집 완료: ${reviews.length}개`);
    return reviews;
  } finally {
    await browser.close();
  }
}
