export interface NaverReview {
  productId: string;
  productName?: string;
  reviewId?: string;
  rating?: number | null;
  authorName?: string | null;
  headline?: string | null;
  content?: string | null;
  optionInfo?: string | null;
  createdAt?: string | null;
  helpfulCount?: number | null;
  hasPhoto?: boolean;
  imageUrls?: string[];
}
