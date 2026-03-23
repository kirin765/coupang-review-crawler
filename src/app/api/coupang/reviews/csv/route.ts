import { NextRequest, NextResponse } from "next/server";
import { extractCoupangProductId } from "@/lib/coupang/extractProductId";
import { scrapeCoupangReviews } from "@/lib/coupang/scrapeReviews";
import { reviewsToCsv } from "@/lib/coupang/reviewToCsv";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

function errorJson(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function handleRequest(url: string | null, rawLimit: unknown) {
  // URL 필수 검증
  if (!url || typeof url !== "string") {
    return errorJson("유효한 쿠팡 상품 URL이 아닙니다.", 400);
  }

  // limit 파싱
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null) {
    limit = typeof rawLimit === "string" ? parseInt(rawLimit, 10) : Number(rawLimit);
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return errorJson("limit은 1 이상 300 이하이어야 합니다.", 400);
    }
  }

  // 쿠팡 상품 ID 추출
  const productId = extractCoupangProductId(url);
  if (!productId) {
    return errorJson("유효한 쿠팡 상품 URL이 아닙니다.", 400);
  }

  console.log(`[reviews/csv] 요청 URL: ${url}, productId: ${productId}, limit: ${limit}`);

  // 리뷰 수집
  let reviews;
  try {
    reviews = await scrapeCoupangReviews({ url, productId, limit });
  } catch (err) {
    console.error("[reviews/csv] 리뷰 수집 실패:", err);
    const message = err instanceof Error ? err.message : "";
    if (message.includes("ACCESS_DENIED") || message.includes("PARSE_FAILED")) {
      return errorJson(
        "쿠팡 페이지 구조 변경 또는 접근 제한으로 인해 수집에 실패했습니다.",
        500
      );
    }
    return errorJson("리뷰 수집에 실패했습니다.", 500);
  }

  console.log(`[reviews/csv] 실제 수집 리뷰 수: ${reviews.length}`);

  // CSV 변환 및 응답
  const csv = reviewsToCsv(reviews);
  const filename = `coupang-reviews-${productId}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** POST /api/coupang/reviews/csv */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    return handleRequest(body.url, body.limit);
  } catch {
    return errorJson("잘못된 요청 형식입니다.", 400);
  }
}

/** GET /api/coupang/reviews/csv?url=...&limit=... */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const url = searchParams.get("url");
  const rawLimit = searchParams.get("limit") ?? undefined;
  return handleRequest(url, rawLimit);
}
