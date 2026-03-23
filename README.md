# 쿠팡 리뷰 크롤러

쿠팡 상품 리뷰를 수집하여 CSV로 반환하는 Next.js API 서버.

## 사전 준비

- Node.js 18+
- Google Chrome 설치 (로컬에서 CDP 연결을 사용할 때)
- Playwright (`npm install` 시 자동 설치)

```bash
npm install
npx playwright install chromium
```

## Chrome CDP 모드 실행

쿠팡은 Akamai Bot Manager로 자동화 도구를 차단합니다.
이를 우회하기 위해 Chrome을 원격 디버깅 모드로 실행해야 합니다.

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/tmp/chrome-cdp-profile"

# Windows
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\tmp\chrome-cdp-profile"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="/tmp/chrome-cdp-profile"
```

> CDP 포트를 변경하려면 환경변수 `CHROME_CDP_URL`을 설정하세요.
> 기본값: `http://127.0.0.1:9222`

## 서버 실행

```bash
npm run dev
# http://localhost:3000
```

## Cloud Run 배포

이 저장소는 루트 `Dockerfile` 기준으로 Google Cloud Run에 바로 배포할 수 있습니다.

### 권장 Cloud Run 설정

- CPU: `1`
- Memory: `2Gi`
- Request timeout: `300s`
- Concurrency: `1`

브라우저를 요청마다 실행하므로 `concurrency 1`이 안전합니다.

### 로컬 소스에서 바로 배포

```bash
gcloud run deploy coupang-review-crawler \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --cpu 1 \
  --memory 2Gi \
  --timeout 300 \
  --concurrency 1
```

### GitHub 저장소 + Dockerfile로 배포

1. 이 저장소를 GitHub에 push
2. Cloud Run에서 **Source repository** 배포를 선택
3. GitHub 저장소를 연결한 뒤 이 저장소를 선택
4. 빌드 방식은 루트 `Dockerfile` 사용
5. 서비스 설정은 위 권장값(CPU/Memory/Timeout/Concurrency) 적용

### Cloud Run 환경 변수

- `CHROME_CDP_URL` (선택): 원격 Chrome/CDP 엔드포인트. 쿠팡 차단을 줄이려면 가장 효과적입니다.
- `PLAYWRIGHT_HEADLESS` (선택): Cloud Run에서는 자동으로 headless 모드가 강제됩니다.

> Cloud Run 단독 headless Chromium은 쿠팡 차단 정책에 걸릴 수 있습니다.
> 안정성이 중요하면 `CHROME_CDP_URL`로 별도 Chrome/CDP 엔드포인트를 연결하세요.

## API 사용법

### POST /api/coupang/reviews/csv

```bash
curl -X POST http://localhost:3000/api/coupang/reviews/csv \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.coupang.com/vp/products/175895807", "limit": 50}' \
  -o reviews.csv
```

### GET /api/coupang/reviews/csv

```bash
curl "http://localhost:3000/api/coupang/reviews/csv?url=https://www.coupang.com/vp/products/175895807&limit=50" \
  -o reviews.csv
```

### 파라미터

| 파라미터 | 필수 | 설명 | 기본값 |
|---------|------|------|--------|
| `url` | O | 쿠팡 상품 URL | - |
| `limit` | X | 수집할 리뷰 수 (1~300) | 100 |

### CSV 컬럼

| 컬럼 | 설명 |
|------|------|
| productId | 상품 ID |
| productName | 상품명 |
| reviewId | 리뷰 ID |
| rating | 별점 (1~5) |
| authorName | 작성자 |
| headline | 리뷰 제목 |
| content | 리뷰 본문 |
| optionInfo | 선택 옵션 |
| createdAt | 작성일 |
| helpfulCount | 도움이 돼요 수 |
| hasPhoto | 사진 포함 여부 |
| imageUrls | 이미지 URL (파이프 구분) |

## 브라우저 연결 우선순위

1. **CDP 연결** — 사용자가 열어놓은 Chrome 또는 원격 Chrome에 연결 (Akamai 우회에 가장 유리)
2. **System Chrome (headed)** — 로컬 개발 환경에서만 시도
3. **Headless Chromium** — Cloud Run 기본값, 차단될 가능성 높음

## 트러블슈팅

- **Access Denied 오류**: Chrome이 CDP 모드로 실행 중인지 확인하세요.
- **리뷰 0개 수집**: 리뷰 API가 403을 반환하는 경우입니다. CDP Chrome에서 쿠팡에 한 번 접속한 뒤 재시도하세요.
- **CDP 연결 실패**: 이미 Chrome이 실행 중이면 같은 포트를 사용할 수 없습니다. `--user-data-dir`을 별도로 지정하세요.
- **Cloud Run에서 차단됨**: `CHROME_CDP_URL`로 외부 Chrome/CDP 엔드포인트를 연결하는 구성이 가장 안정적입니다.
