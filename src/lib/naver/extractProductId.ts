const SUPPORTED_HOSTNAMES = new Set([
  "brand.naver.com",
  "smartstore.naver.com",
  "m.smartstore.naver.com",
]);

function isLikelyProductId(value: string): boolean {
  return /^\d{5,}$/.test(value);
}

/**
 * 네이버 스마트스토어 상품 URL에서 productId를 추출한다.
 * 지원 형식:
 * - https://brand.naver.com/<store>/products/<productId>
 * - https://smartstore.naver.com/<store>/products/<productId>
 */
export function extractNaverProductId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (!SUPPORTED_HOSTNAMES.has(hostname)) {
      return null;
    }

    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    for (let i = 0; i < pathSegments.length - 1; i += 1) {
      if (pathSegments[i].toLowerCase() === "products" && isLikelyProductId(pathSegments[i + 1])) {
        return pathSegments[i + 1];
      }
    }

    const pathMatch = parsed.pathname.match(/\/products\/(\d{5,})/i);
    if (pathMatch) {
      return pathMatch[1];
    }

    const queryCandidates = [
      parsed.searchParams.get("productId"),
      parsed.searchParams.get("productNo"),
      parsed.searchParams.get("id"),
      parsed.searchParams.get("nvMid"),
    ];
    for (const candidate of queryCandidates) {
      if (candidate && isLikelyProductId(candidate)) {
        return candidate;
      }
    }

    return null;
  } catch {
    return null;
  }
}
