# GitHub 추천 시스템

GitHub OAuth를 이용한 추천 시스템입니다. 사용자는 GitHub 계정으로 인증한 후 다른 GitHub 사용자를 추천할 수 있습니다.

## 기능

- **GitHub OAuth 인증**: 추천하는 사람은 GitHub 계정으로 인증되어야 합니다
- **중복 추천 방지**: 같은 사용자는 한 사람을 한 번만 추천할 수 있습니다
- **추천 조회**: 특정 GitHub 사용자를 추천한 모든 사람들의 목록을 확인할 수 있습니다

## 기술 스택

- **Backend**: Node.js + Express
- **Database**: SQLite
- **Authentication**: GitHub OAuth (Passport.js)
- **Frontend**: Vanilla JavaScript + HTML/CSS
- **Deployment**: Docker + Docker Compose + Cloudflare Tunnel

## 로컬 개발 환경 설정

### 1. GitHub OAuth 앱 생성

1. [GitHub Developer Settings](https://github.com/settings/developers)로 이동
2. "New OAuth App" 클릭
3. 다음 정보 입력:
   - **Application name**: GitHub 추천 시스템 (또는 원하는 이름)
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
4. "Register application" 클릭
5. **Client ID**와 **Client Secret**을 메모

### 2. 환경 변수 설정

프로젝트 루트에 `.env` 파일을 생성하고 다음 내용을 입력:

```env
# GitHub OAuth Configuration
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here

# Session Configuration
SESSION_SECRET=your_random_session_secret_here

# Server Configuration
PORT=3000
CALLBACK_URL=http://localhost:3000/auth/github/callback
```

### 3. 의존성 설치 및 실행

```bash
# 의존성 설치
npm install

# 서버 실행
npm start

# 개발 모드로 실행 (nodemon 필요)
npm run dev
```

서버가 `http://localhost:3000`에서 실행됩니다.

## Docker를 이용한 배포

### 1. 초기 설정 (오픈소스 배포용)

이 프로젝트는 오픈소스로 공개되어 있으며, 처음 실행할 때 자동으로 데이터베이스가 초기화됩니다.

**중요**: `referrals.db` 파일이 없어도 자동으로 생성되므로 별도의 데이터베이스 설정이 필요하지 않습니다.

### 2. Cloudflare Tunnel 설정

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)에 로그인
2. "Access" → "Tunnels"로 이동
3. "Create a tunnel" 클릭
4. 터널 이름 입력 (예: github-referral)
5. "Save tunnel" 클릭
6. 설치 명령어에서 토큰 부분을 복사

### 3. 환경 변수 설정

`.env` 파일에 다음 내용을 추가:

```env
# GitHub OAuth Configuration
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here

# Session Configuration
SESSION_SECRET=your_random_session_secret_here

# Server Configuration
PORT=3000
CALLBACK_URL=https://yourdomain.com/auth/github/callback

# Cloudflare Tunnel Token
CLOUDFLARE_TUNNEL_TOKEN=your_tunnel_token_here

# Optional: Avatar settings
AVATAR_ENABLE=true
AVATAR_TIMEOUT_MS=5000
AVATAR_CONCURRENCY=2
SVG_CACHE_TTL_MS=600000
NODE_ENV=production
```

### 4. Docker Compose로 실행

```bash
# 빌드 및 실행
docker-compose up -d

# 로그 확인
docker-compose logs -f

# 중지
docker-compose down
```

### 5. Cloudflare Tunnel 연결

Cloudflare 대시보드에서 터널을 설정할 때:
- **Public hostname**: 원하는 도메인 (예: referral.yourdomain.com)
- **Service**: HTTP
- **URL**: `localhost:3000` (network_mode: host 사용)

### 6. 데이터베이스 자동 초기화

컨테이너가 처음 실행될 때 자동으로 다음 작업이 수행됩니다:

1. **데이터베이스 파일 생성**: `referrals.db` 파일이 자동으로 생성됩니다
2. **테이블 생성**: `users`와 `recommendations` 테이블이 자동으로 생성됩니다
3. **인덱스 생성**: 성능 최적화를 위한 인덱스가 자동으로 생성됩니다
4. **권한 설정**: 적절한 파일 권한이 자동으로 설정됩니다

**주의사항**:
- 기존 `referrals.db` 파일이 있다면 그대로 사용됩니다
- 데이터베이스 파일은 Docker 볼륨에 저장되어 컨테이너 재시작 시에도 유지됩니다
- 데이터를 완전히 초기화하려면 `docker-compose down -v`로 볼륨을 삭제한 후 다시 시작하세요

## API 엔드포인트

### 인증
- `GET /auth/github` - GitHub 로그인
- `GET /auth/github/callback` - OAuth 콜백
- `GET /logout` - 로그아웃
- `GET /api/user` - 현재 사용자 정보

### 추천
- `POST /api/recommend` - 사용자 추천
  ```json
  {
    "recommendedUsername": "target-github-username"
  }
  ```
- `GET /api/recommendations/:username` - 추천 목록 조회

## 데이터베이스 스키마

### users 테이블
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER UNIQUE,
  username TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### recommendations 테이블
```sql
CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recommender_id INTEGER,
  recommended_username TEXT,
  recommendation_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE(recommender_id, recommended_username)
);
```

## 보안 고려사항

- 프로덕션 환경에서는 HTTPS를 사용하세요
- SESSION_SECRET은 강력한 랜덤 문자열로 설정하세요
- 데이터베이스 파일은 백업하고 안전하게 보관하세요

## 라이선스

이 프로젝트는 MIT 라이선스를 따릅니다.

