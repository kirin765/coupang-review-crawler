import { CoupangReview } from "./types";

const CSV_COLUMNS = [
  "productId",
  "productName",
  "reviewId",
  "rating",
  "authorName",
  "headline",
  "content",
  "optionInfo",
  "createdAt",
  "helpfulCount",
  "hasPhoto",
  "imageUrls",
] as const;

/** CSV 필드를 안전하게 escape 처리 */
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  const str = String(value);
  // 쉼표, 큰따옴표, 줄바꿈이 포함되면 큰따옴표로 감싸고 내부 큰따옴표는 두 번 반복
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** CoupangReview 배열을 UTF-8 BOM 포함 CSV 문자열로 변환 */
export function reviewsToCsv(reviews: CoupangReview[]): string {
  const BOM = "\uFEFF";
  const header = CSV_COLUMNS.join(",");

  const rows = reviews.map((review) => {
    return CSV_COLUMNS.map((col) => {
      if (col === "imageUrls") {
        const urls = review.imageUrls;
        return escapeCsvField(Array.isArray(urls) ? urls.join("|") : "");
      }
      if (col === "hasPhoto") {
        return escapeCsvField(review.hasPhoto ? "true" : "false");
      }
      return escapeCsvField(review[col as keyof CoupangReview]);
    }).join(",");
  });

  return BOM + [header, ...rows].join("\r\n") + "\r\n";
}
