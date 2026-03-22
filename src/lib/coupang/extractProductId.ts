/**
 * 쿠팡 상품 URL에서 productId를 추출한다.
 * 지원 형식: https://www.coupang.com/vp/products/<productId>?...
 */
export function extractCoupangProductId(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (
      parsed.hostname !== "www.coupang.com" &&
      parsed.hostname !== "m.coupang.com" &&
      parsed.hostname !== "coupang.com"
    ) {
      return null;
    }

    const match = parsed.pathname.match(/^\/vp\/products\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
