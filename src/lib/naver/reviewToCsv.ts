import { NaverReview } from "./types";

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

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function reviewsToCsv(reviews: NaverReview[]): string {
  const BOM = "\uFEFF";
  const header = CSV_COLUMNS.join(",");
  const rows = reviews.map((review) =>
    CSV_COLUMNS.map((col) => {
      if (col === "imageUrls") {
        const urls = review.imageUrls;
        return escapeCsvField(Array.isArray(urls) ? urls.join("|") : "");
      }
      if (col === "hasPhoto") {
        return escapeCsvField(review.hasPhoto ? "true" : "false");
      }
      return escapeCsvField(review[col as keyof NaverReview]);
    }).join(",")
  );

  return BOM + [header, ...rows].join("\r\n") + "\r\n";
}
