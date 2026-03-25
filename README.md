# 리뷰 크롤러 API (쿠팡 / 네이버 스마트스토어)

쿠팡 또는 네이버 스마트스토어 상품 리뷰를 수집하여 CSV로 반환하는 Next.js API 서버.

## 사전 준비

- Node.js 18+
- Google Chrome 설치 (로컬에서 CDP 연결을 사용할 때)
- Playwright (`npm install` 시 자동 설치)

```bash
npm install
npx playwright install chromium
```

## Chrome CDP 모드 실행

쿠팡/네이버는 자동화 트래픽을 차단할 수 있습니다.
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

프로덕션 서버에서는 다음처럼 실행할 수 있습니다.

```bash
npm install
npx playwright install chromium
npm run build
PORT=3000 npm run start
```

이제 `npm run start`는 기본적으로 다음 순서로 동작합니다.

- `CHROME_CDP_URL`이 지정되어 있으면 그 CDP에 연결
- 지정되어 있지 않으면 프로젝트가 같은 서버에서 로컬 Chromium CDP를 자동으로 기동
- 그 다음 Next.js 서버를 시작

즉, 별도 설정이 없다면 프로젝트가 알아서 `127.0.0.1:9222` CDP를 올립니다.
서버에 화면이 없으면 `Xvfb`를 같이 띄워서 headed Chromium으로 실행합니다.

배포 서버에서 같은 호스트의 CDP를 함께 사용할 계획이라면 아래처럼 그대로 실행하면 됩니다.

```bash
npm install
npx playwright install chromium
npm run build
PORT=3000 npm run start
```

이 동작을 강제로 제어하고 싶다면:

- `START_LOCAL_CDP=true` : 항상 로컬 CDP 기동
- `START_LOCAL_CDP=false` : 로컬 CDP 자동 기동 비활성화

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

- `CHROME_CDP_URL` (선택): 원격 Chrome/CDP 엔드포인트. 쿠팡/네이버 차단을 줄이려면 가장 효과적입니다.
- `PLAYWRIGHT_HEADLESS` (선택): Cloud Run에서는 자동으로 headless 모드가 강제됩니다.
- `ALLOWED_ORIGINS` (선택): CORS 허용 Origin 목록. 쉼표로 구분합니다. 기본값은 `https://reviewboost.co.kr,https://www.reviewboost.co.kr` 입니다.
- `START_LOCAL_CDP` (선택): 비어 있으면 `CHROME_CDP_URL` 미설정 시 자동으로 로컬 CDP를 띄웁니다. `true`면 강제 활성화, `false`면 비활성화합니다.
- `CDP_PORT` (선택): 로컬 CDP 포트. 기본값은 `9222` 입니다.
- `CDP_USER_DATA_DIR` (선택): 로컬 CDP 프로필 경로. 기본값은 `/tmp/chrome-cdp-profile` 입니다.
- `LOCAL_CDP_HEADLESS` (선택): `1` 또는 `true`면 로컬 CDP Chromium을 headless로 실행합니다. 기본값은 `false` 입니다.
- `XVFB_DISPLAY` (선택): headed Chromium용 가상 디스플레이. 기본값은 `:99` 입니다.
- `XVFB_SCREEN` (선택): Xvfb 스크린 크기/색심도. 기본값은 `1280x720x24` 입니다.

> Cloud Run 단독 headless Chromium은 쿠팡/네이버 차단 정책에 걸릴 수 있습니다.
> 안정성이 중요하면 `CHROME_CDP_URL`로 별도 Chrome/CDP 엔드포인트를 연결하세요.

## 같은 서버에서 CDP 운영

일반적인 Linux 서버 배포에서는 별도 설정이 없으면 애플리케이션이 `http://127.0.0.1:9222` CDP를 먼저 시도합니다.

### 1) 앱이 직접 로컬 CDP를 띄우는 방식

```bash
ALLOWED_ORIGINS=https://reviewboost.co.kr,https://www.reviewboost.co.kr \
PORT=3000 \
npm run start
```

### 2) CDP를 별도 프로세스로 띄우는 방식

이미 서버에서 Chrome/Chromium을 CDP 모드로 올려둘 계획이라면 앱은 그대로 `npm run start`만 실행해도 됩니다.
필요하면 아래처럼 명시적으로 URL을 지정할 수 있습니다.

```bash
CHROME_CDP_URL=http://127.0.0.1:9222 \
ALLOWED_ORIGINS=https://reviewboost.co.kr,https://www.reviewboost.co.kr \
PORT=3000 \
npm run start
```

### Docker 컨테이너에서 같은 서버 CDP 사용

현재 `Dockerfile`은 `node scripts/start-with-local-cdp.mjs`로 시작합니다.
기본 동작은 `CHROME_CDP_URL`이 없으면 같은 컨테이너 안에서 Chromium CDP를 함께 띄우는 것입니다.

```bash
docker run --rm -p 8080:8080 \
  -e ALLOWED_ORIGINS=https://reviewboost.co.kr,https://www.reviewboost.co.kr \
  coupang-review-crawler
```

## API 사용법

### POST /api/coupang/reviews/csv

이 엔드포인트는 전달된 `url`을 보고 자동으로 마켓플레이스를 판별합니다.

쿠팡 URL이면 쿠팡 리뷰를, `naver`가 포함된 네이버 스마트스토어 URL이면 네이버 리뷰를 수집합니다.

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

네이버 스마트스토어 URL 예시:

```bash
curl -X POST http://localhost:3000/api/coupang/reviews/csv \
  -H "Content-Type: application/json" \
  -d '{"url": "https://brand.naver.com/lottewellfoodmall/products/13242965454", "limit": 50}' \
  -o naver-reviews.csv
```

```bash
curl "http://localhost:3000/api/coupang/reviews/csv?url=https://brand.naver.com/lottewellfoodmall/products/13242965454&limit=50" \
  -o naver-reviews.csv
```

네이버 스마트스토어 지원 URL 예시:

- `https://brand.naver.com/<store>/products/<productId>`
- `https://smartstore.naver.com/<store>/products/<productId>`

### `reviewboost.co.kr` 프런트엔드에서 다운로드

브라우저 `fetch`로 직접 호출하려면 서버가 `https://reviewboost.co.kr` Origin을 허용해야 합니다.
이 저장소는 기본적으로 `https://reviewboost.co.kr`와 `https://www.reviewboost.co.kr`를 CORS 허용 목록에 포함합니다.

```ts
const response = await fetch("https://YOUR-SERVER/api/coupang/reviews/csv", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: "https://www.coupang.com/vp/products/175895807",
    limit: 50,
  }),
});

if (!response.ok) {
  throw new Error("CSV 다운로드 실패");
}

const blob = await response.blob();
const disposition = response.headers.get("Content-Disposition");
const filenameMatch = disposition?.match(/filename="([^"]+)"/);
const filename = filenameMatch?.[1] ?? "reviews.csv";

const downloadUrl = URL.createObjectURL(blob);
const anchor = document.createElement("a");
anchor.href = downloadUrl;
anchor.download = filename;
anchor.click();
URL.revokeObjectURL(downloadUrl);
```

서버를 다른 도메인 조합으로 운영한다면 `ALLOWED_ORIGINS` 환경 변수에 Vercel Origin을 추가하세요.

### 파라미터

| 파라미터 | 필수 | 설명 | 기본값 |
|---------|------|------|--------|
| `url` | O | 쿠팡/네이버 상품 URL | - |
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
- **리뷰 0개 수집**: 사이트 측 리뷰 API 응답이 비어 있거나 차단된 경우입니다. CDP Chrome에서 대상 사이트(쿠팡/네이버)에 한 번 접속한 뒤 재시도하세요.
- **CDP 연결 실패**: 이미 Chrome이 실행 중이면 같은 포트를 사용할 수 없습니다. `--user-data-dir`을 별도로 지정하세요.
- **Cloud Run에서 차단됨**: `CHROME_CDP_URL`로 외부 Chrome/CDP 엔드포인트를 연결하는 구성이 가장 안정적입니다.
