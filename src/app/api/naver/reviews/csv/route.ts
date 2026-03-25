import { NextRequest, NextResponse } from "next/server";
import { extractNaverProductId } from "@/lib/naver/extractProductId";
import { scrapeNaverReviews } from "@/lib/naver/scrapeReviews";
import { reviewsToCsv } from "@/lib/naver/reviewToCsv";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const DEFAULT_ALLOWED_ORIGINS = [
  "https://reviewboost.co.kr",
  "https://www.reviewboost.co.kr",
];

function getAllowedOrigins(): string[] {
  const rawOrigins = process.env.ALLOWED_ORIGINS?.trim();
  if (!rawOrigins) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getCorsHeaders(origin: string | null): HeadersInit {
  if (!origin) {
    return {};
  }

  if (!getAllowedOrigins().includes(origin)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Type, Content-Length",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function errorJson(message: string, status: number, origin: string | null = null) {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: getCorsHeaders(origin),
    }
  );
}

function ensureOriginAllowed(origin: string | null) {
  if (!origin) {
    return null;
  }

  if (!getAllowedOrigins().includes(origin)) {
    return errorJson("허용되지 않은 Origin입니다.", 403);
  }

  return null;
}

async function handleRequest(url: string | null, rawLimit: unknown, origin: string | null) {
  if (!url || typeof url !== "string") {
    return errorJson("유효한 네이버 스마트스토어 상품 URL이 아닙니다.", 400, origin);
  }

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null) {
    limit = typeof rawLimit === "string" ? parseInt(rawLimit, 10) : Number(rawLimit);
    if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return errorJson("limit은 1 이상 300 이하이어야 합니다.", 400, origin);
    }
  }

  const productId = extractNaverProductId(url);
  if (!productId) {
    return errorJson("유효한 네이버 스마트스토어 상품 URL이 아닙니다.", 400, origin);
  }

  console.log(`[naver/reviews/csv] 요청 URL: ${url}, productId: ${productId}, limit: ${limit}`);

  let reviews;
  try {
    reviews = await scrapeNaverReviews({ url, productId, limit });
  } catch (err) {
    console.error("[naver/reviews/csv] 리뷰 수집 실패:", err);
    const message = err instanceof Error ? err.message : "";
    if (message.includes("ACCESS_DENIED") || message.includes("PARSE_FAILED")) {
      return errorJson(
        "네이버 스마트스토어 페이지 구조 변경 또는 접근 제한으로 인해 수집에 실패했습니다.",
        500,
        origin
      );
    }
    return errorJson("리뷰 수집에 실패했습니다.", 500, origin);
  }

  console.log(`[naver/reviews/csv] 실제 수집 리뷰 수: ${reviews.length}`);

  const csv = reviewsToCsv(reviews);
  const filename = `naver-reviews-${productId}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...getCorsHeaders(origin),
    },
  });
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  const rejectedResponse = ensureOriginAllowed(origin);

  if (rejectedResponse) {
    return rejectedResponse;
  }

  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

/** POST /api/naver/reviews/csv */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const rejectedResponse = ensureOriginAllowed(origin);

  if (rejectedResponse) {
    return rejectedResponse;
  }

  try {
    const body = await request.json();
    return handleRequest(body.url, body.limit, origin);
  } catch {
    return errorJson("잘못된 요청 형식입니다.", 400, origin);
  }
}

/** GET /api/naver/reviews/csv?url=...&limit=... */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const rejectedResponse = ensureOriginAllowed(origin);

  if (rejectedResponse) {
    return rejectedResponse;
  }

  const { searchParams } = request.nextUrl;
  const url = searchParams.get("url");
  const rawLimit = searchParams.get("limit") ?? undefined;
  return handleRequest(url, rawLimit, origin);
}
