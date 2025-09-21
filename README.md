# GitHub 추천 시스템 (Referral System)

GitHub OAuth를 이용한 개발자 추천 시스템입니다. 사용자는 GitHub 계정으로 인증한 후 다른 GitHub 사용자를 추천할 수 있으며, 추천 정보는 SVG 배지 형태로 시각화됩니다.

## 🚀 주요 기능

- **GitHub OAuth 인증**: GitHub 계정으로 안전한 로그인
- **개발자 추천**: 다른 GitHub 사용자를 추천하고 추천사 작성 가능
- **SVG 배지 생성**: 추천 정보를 시각적인 SVG 배지로 표시
- **추천 관리**: 본인이 받은 추천사들을 관리하고 공개/비공개 설정 가능
- **중복 추천 허용**: 같은 사용자를 여러 번 추천 가능
- **실시간 캐싱**: Cloudflare 친화적 캐싱으로 성능 최적화

## 🛠 기술 스택

### Backend
- **Node.js** + **Express.js** - 웹 서버
- **SQLite** - 데이터베이스 (WAL 모드)
- **Passport.js** - 인증 미들웨어
- **GitHub OAuth 2.0** - 소셜 로그인

### Frontend
- **Vanilla JavaScript** - 클라이언트 사이드 로직
- **HTML5/CSS3** - 반응형 UI
- **SVG** - 동적 배지 생성

### Infrastructure
- **Docker** + **Docker Compose** - 컨테이너화
- **Caddy** - 리버스 프록시 및 SSL 터미네이션
- **Cloudflare** - CDN 및 캐싱

## 📁 프로젝트 구조

```
referral/
├── server.js              # 메인 서버 파일
├── package.json           # Node.js 의존성
├── docker-compose.yml     # Docker Compose 설정
├── Dockerfile            # Docker 이미지 빌드
├── Caddyfile             # Caddy 리버스 프록시 설정
├── public/               # 정적 파일
│   ├── index.html        # 메인 페이지
│   ├── recommend.html    # 추천 페이지
│   ├── manage.html       # 추천사 관리 페이지
│   ├── local-login.html  # 개발용 로컬 로그인
│   ├── style.css         # 스타일시트
│   └── js/
│       └── escape.js     # XSS 방지 유틸리티
├── schema/               # 데이터베이스 스키마
│   ├── init.sql          # 초기 데이터베이스 생성
│   └── migration.sql     # 데이터베이스 마이그레이션
├── scripts/              # 유틸리티 스크립트
│   └── start.sh          # 애플리케이션 시작 스크립트
├── data/                 # 데이터베이스 파일 (볼륨)
└── logs/                 # 로그 파일
```

## 🚀 빠른 시작

### 1. GitHub OAuth 앱 생성

1. [GitHub Developer Settings](https://github.com/settings/developers)에서 "New OAuth App" 클릭
2. 다음 정보 입력:
   - **Application name**: GitHub 추천 시스템
   - **Homepage URL**: `http://localhost:3000` (로컬) 또는 `https://yourdomain.com` (프로덕션)
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback` (로컬) 또는 `https://yourdomain.com/auth/github/callback` (프로덕션)
3. **Client ID**와 **Client Secret** 복사

### 2. 환경 변수 설정

프로젝트 루트에 `.env` 파일 생성:

```env
# GitHub OAuth 설정
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here

# 서버 설정
PORT=3000
CALLBACK_URL=http://localhost:3000/auth/github/callback

# 세션 설정
SESSION_SECRET=your_random_session_secret_here

# 데이터베이스 설정
REFERRALS_DATA_DIR=/app/data
REFERRALS_DB_PATH=/app/data/referrals.db

# 아바타 설정 (선택사항)
AVATAR_ENABLE=true
AVATAR_TIMEOUT_MS=5000
AVATAR_CONCURRENCY=2

# 캐시 설정
SVG_CACHE_TTL_MS=600000

# 환경 설정
NODE_ENV=production

# 도메인 설정 (프로덕션)
DOMAIN=yourdomain.com
```

### 3. 로컬 개발 환경

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev

# 또는 프로덕션 모드
npm start
```

서버가 `http://localhost:3000`에서 실행됩니다.

### 4. Docker를 이용한 배포

```bash
# 빌드 및 실행
docker-compose up -d

# 로그 확인
docker-compose logs -f

# 중지
docker-compose down
```

## 📊 데이터베이스 스키마

### users 테이블
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### recommendations 테이블
```sql
CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recommender_id INTEGER NOT NULL,
  recommended_username TEXT NOT NULL COLLATE NOCASE,
  recommendation_text TEXT,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
```

## 🔌 API 엔드포인트

### 인증
- `GET /auth/github` - GitHub 로그인
- `GET /auth/github/callback` - OAuth 콜백
- `GET /logout` - 로그아웃
- `GET /api/user` - 현재 사용자 정보

### 추천
- `POST /api/recommend` - 사용자 추천
  ```json
  {
    "recommendedUsername": "target-github-username",
    "recommendationText": "추천사 (선택사항, 최대 500자)"
  }
  ```

### 추천 조회 및 관리
- `GET /u/:username` - 받은 추천사 목록을 SVG 형식으로 반환(Github 등에 첨부 가능한 이미지 형식)
- `GET /t/:username` - 추천 페이지
- `GET /u/:username/admin` - 추천사 관리 페이지
- `GET /api/received-recommendations/:username` - 받은 추천사 목록을 JSON 형식으로 반환
- `POST /api/toggle-recommendation-visibility` - 추천사 공개/비공개 설정

### 기타
- `GET /health` - 헬스 체크
- `GET /renderer-test` - SVG 렌더러 테스트 (개발 모드에서만 동작)

## 🎨 SVG 배지 기능

- **동적 생성**: 실시간으로 추천 정보를 SVG로 렌더링
- **아바타 표시**: GitHub 아바타 이미지를 Base64로 인라인 삽입
- **다중 라인 텍스트**: 긴 추천사를 여러 줄로 자동 분할
- **캐싱**: 메모리 캐시와 Cloudflare CDN 캐싱으로 성능 최적화
- **304 Not Modified**: 클라이언트 캐시 지원

## 🔧 고급 설정

### 개발 모드
- GitHub OAuth 설정이 없으면 로컬 로그인 모드로 전환
- `/local-login` 페이지에서 임의 사용자명으로 로그인 가능

### 프로덕션 모드
- GitHub OAuth 필수
- 로컬 로그인 비활성화
- Cloudflare 캐싱 최적화

### 데이터베이스 마이그레이션
- 자동 마이그레이션 지원
- 기존 데이터 보존하면서 스키마 업데이트
- 롤백 가능한 안전한 마이그레이션

## 🚀 배포

### Docker Compose 배포
1. `.env` 파일 설정
2. `docker-compose up -d` 실행
3. Caddy가 자동으로 SSL 인증서 발급

### 수동 배포
1. Node.js 환경에서 `npm install` 실행
2. 데이터베이스 초기화: `sqlite3 referrals.db < schema/init.sql`
3. `npm start`로 서버 실행

## 🔒 보안 기능

- **XSS 방지**: HTML 이스케이프 처리
- **CSRF 보호**: CSRF 토큰(또는 Origin/Referer 검증) + SameSite=Lax 쿠키
  - 변경사항: POST/PUT/DELETE 요청에 CSRF 토큰 검증을 적용하거나, 최소한 Origin/Referer 검증을 문서화하세요.
- **SQL 인젝션 방지**: Prepared statements 사용
- **파일 권한**: 데이터베이스 파일 보안 권한 설정
- **헤더 보안**: Caddy를 통한 보안 헤더 설정

## 📝 라이선스

이 프로젝트는 MIT 라이선스를 따릅니다.

## 🤝 기여하기

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📞 지원

문제가 발생하거나 질문이 있으시면 GitHub Issues를 통해 문의해주세요.