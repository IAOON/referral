const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: LocalStrategy } = require('passport-local');
const { Strategy: GitHubStrategy } = require('passport-github2');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// SVG 생성 중인 요청들을 추적하는 Map
const pendingRequests = new Map(); // username -> Promise<svg>
// 완성된 SVG 캐시
const svgCache = new Map(); // username -> { svg: string, expiresAt: number }

// Database setup
const dbPath = process.env.REFERRALS_DB_PATH || `/app/data/referrals.db`;
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    // Enforce foreign key constraints to protect referential integrity
    db.run('PRAGMA foreign_keys = ON');
    
    // Database migrations are now handled by schema/migration.sql
    // No need for application-level migration logic
  }
});

// Migration functions removed - now handled by schema/migration.sql

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'SESSION_SECRET_EXAMPLE',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

// dev purpose only - 프로덕션에서는 비활성화
const isNoLogin = (process.env.GITHUB_CLIENT_ID === undefined)
const isProduction = (process.env.NODE_ENV === 'production')

// 프로덕션에서 로컬 로그인 방지
if (isNoLogin && isProduction) {
  console.error('ERROR: Local login is not allowed in production environment!');
  console.error('Please set GITHUB_CLIENT_ID environment variable.');
  process.exit(1);
}

let passportStrategy;
if (isNoLogin) {
  console.warn('WARNING: Using local login strategy. This should only be used in development!');
  
  const verify = (username, password, done) => {
    // Upsert user to ensure they exist in the database
    db.run(
      `INSERT INTO users (github_id, username, name)
       VALUES (?, ?, ?)
       ON CONFLICT(github_id) DO UPDATE SET
         username=excluded.username,
         name=excluded.name`,
      [username, username, username],
      function(err) {
        if (err) {
          return done(err);
        }
        // Get the user ID after upsert - 대소문자 정규화
        db.get('SELECT id FROM users WHERE LOWER(github_id) = LOWER(?)', [username], (err, user) => {
          if (err) {
            return done(err);
          }
          return done(null, { id: user.id, github_id: username, username: username });
        });
      }
    );
  };
  passportStrategy = new LocalStrategy(verify);
} else {
  const verify = (accessToken, refreshToken, profile, done) => {
    // Upsert user without replacing the row to preserve the stable primary key
    db.run(
      `INSERT INTO users (github_id, username, name)
       VALUES (?, ?, ?)
       ON CONFLICT(github_id) DO UPDATE SET
         username=excluded.username,
         name=excluded.name`,
      [profile.id, profile.username, profile.displayName || profile.name || profile.username || 'Unknown User'],
      function(err) {
        if (err) {
          return done(err);
        }
        // Fetch the (stable) user id to keep downstream logic working
        db.get(`SELECT id FROM users WHERE LOWER(github_id) = ?`, [profile.id], (selErr, row) => {
          if (selErr) {
            return done(selErr);
          }
          return done(null, { id: row?.id, github_id: profile.id, username: profile.username });
        });
      }
    );
  };
  passportStrategy = new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: process.env.CALLBACK_URL || "http://localhost:3000/auth/github/callback"
    },
    verify,
  );
}

// Passport setup
passport.use(passportStrategy);

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

app.use(passport.initialize());
app.use(passport.session());


// Routes
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

if (isNoLogin) {
  // Local-only routes
  app.get('/local-login', (req, res) => {
    res.sendFile(__dirname + '/public/local-login.html');
  });

  app.post('/login-local', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/local-login',
  }));
}

// Authentication routes
app.get('/auth/github',
  function(req, res, next) {
    if (isNoLogin) {
      res.status(302).location('/local-login').send();
      return;
    }
    // Pass returnTo as state parameter to GitHub OAuth
    const state = req.query.returnTo || '/';
    passport.authenticate('github', { 
      scope: ['user:email'],
      state: state
    })(req, res, next);
  });

app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/' }),
  function(req, res) {
    // Redirect to state parameter (which contains returnTo URL)
    const returnTo = req.query.state || '/';
    res.redirect(returnTo);
  });

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json(req.user);
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Recommendation routes
app.post('/api/recommend', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { recommendedUsername, recommendationText } = req.body;

  if (!recommendedUsername) {
    return res.status(400).json({ error: 'Recommended username is required' });
  }

  // Validate recommendation text length (optional, max 500 chars)
  if (recommendationText && recommendationText.length > 500) {
    return res.status(400).json({ error: 'Recommendation text must be 500 characters or less' });
  }

  // First, check if the recommender exists in the database
  db.get(`SELECT id FROM users WHERE LOWER(github_id) = LOWER(?)`, [req.user.github_id], (err, user) => {
    if (err) {
      console.error('Database error when checking user:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.error('User not found in database:', req.user.github_id);
      return res.status(400).json({ error: 'User not found. Please log in again.' });
    }

    // Add recommendation (duplicate recommendations are now allowed)
    db.run(`INSERT INTO recommendations (recommender_id, recommended_username, recommendation_text)
            VALUES (?, ?, ?)`,
      [user.id, recommendedUsername, recommendationText || null], function(err) {
      if (err) {
        console.error('Database error when saving recommendation:', err);
        console.error('User id:', user.id);
        console.error('Recommended username:', recommendedUsername);
        return res.status(500).json({ error: 'Failed to save recommendation' });
      }
      
      // 캐시 무효화 - 해당 사용자의 SVG 캐시 제거
      const cacheKey = recommendedUsername.toLowerCase();
      svgCache.delete(cacheKey);
      console.log(`[${recommendedUsername}] Cache invalidated after new recommendation`);
      
      res.json({ success: true, message: 'Recommendation added successfully' });
    });
  });
});

// Function to fetch avatar image and convert to base64
function fetchAvatarAsBase64(avatarUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }
    
    const url = new URL(avatarUrl);
    const client = url.protocol === 'https:' ? https : http;
    
    const avatarTimeout = parseInt(process.env.AVATAR_TIMEOUT_MS) || 5000;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReferralBot/1.0)',
        'Accept': 'image/*'
      },
      timeout: avatarTimeout
    };
    
    const request = client.request(options, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location.startsWith('http') 
          ? response.headers.location 
          : `${url.protocol}//${url.host}${response.headers.location}`;
        console.log(`Redirecting from ${avatarUrl} to ${redirectUrl}`);
        return fetchAvatarAsBase64(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch avatar: ${response.statusCode} ${response.statusMessage}`));
        return;
      }
      
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const contentType = response.headers['content-type'] || 'image/png';
        resolve(`data:${contentType};base64,${base64}`);
      });
    });
    
    request.on('error', (err) => {
      reject(err);
    });
    
    // Set timeout using environment variable
    request.setTimeout(avatarTimeout, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
    
    request.end();
  });
}

// Function to calculate maximum lines needed for text
function calculateMaxLines(text, maxLength) {
  if (!text) return 1;
  
  // Split by double newlines first to handle paragraphs
  const paragraphs = text.split(/\n\s*\n/);
  let totalLines = 0;
  
  for (const paragraph of paragraphs) {
    // Split paragraph by single newlines
    const lines = paragraph.split('\n');
    
    for (const line of lines) {
      // Skip empty lines within paragraphs
      if (line.trim() === '') continue;
      
      if (line.length <= maxLength) {
        totalLines += 1;
      } else {
        // Calculate how many lines this long line will need
        const words = line.trim().split(' ');
        let currentLineLength = 0;
        
        for (const word of words) {
          const testLength = currentLineLength + (currentLineLength ? 1 : 0) + word.length;
          if (testLength <= maxLength) {
            currentLineLength = testLength;
          } else {
            totalLines += 1;
            currentLineLength = word.length;
          }
        }
        
        if (currentLineLength > 0) {
          totalLines += 1;
        }
      }
    }
    
    // Add empty line between paragraphs (if not the last paragraph)
    if (paragraphs.length > 1) {
      const isLastParagraph = paragraphs.indexOf(paragraph) === paragraphs.length - 1;
      if (!isLastParagraph) {
        totalLines += 1; // Empty line for paragraph separation
      }
    }
  }
  
  return Math.max(1, totalLines);
}

// Function to split text into multiple lines for SVG rendering
function splitTextIntoLines(text, maxLength) {
  if (!text) return [];
  
  const maxLines = calculateMaxLines(text, maxLength);
  
  // Split by double newlines first to handle paragraphs
  const paragraphs = text.split(/\n\s*\n/);
  const result = [];
  
  for (const paragraph of paragraphs) {
    if (result.length >= maxLines) break;
    
    // Split paragraph by single newlines
    const lines = paragraph.split('\n');
    
    for (const line of lines) {
      if (result.length >= maxLines) break;
      
      // Skip empty lines within paragraphs
      if (line.trim() === '') continue;
      
      if (line.length <= maxLength) {
        result.push(line.trim());
      } else {
        // Split long lines by words
        const words = line.trim().split(' ');
        let currentLine = '';
        
        for (const word of words) {
          if (result.length >= maxLines) break;
          
          const testLine = currentLine + (currentLine ? ' ' : '') + word;
          if (testLine.length <= maxLength) {
            currentLine = testLine;
          } else {
            if (currentLine) {
              result.push(currentLine);
              currentLine = word;
            } else {
              // Single word is too long, truncate it
              result.push(word.substring(0, maxLength - 3) + '...');
            }
          }
        }
        
        if (currentLine && result.length < maxLines) {
          result.push(currentLine);
        }
      }
    }
    
    // Add empty line between paragraphs (if not the last paragraph and we have space)
    if (paragraphs.length > 1 && result.length < maxLines && result.length > 0) {
      const isLastParagraph = paragraphs.indexOf(paragraph) === paragraphs.length - 1;
      if (!isLastParagraph) {
        result.push(''); // Empty line for paragraph separation
      }
    }
  }
  
  return result;
}

// XML/SVG 이스케이프 함수
function escapeXml(unsafe) {
  if (typeof unsafe !== 'string') {
    return '';
  }
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Function to generate SVG badge
async function generateRecommendationsSVG(username, recommenders) {
  const width = 400;
  const headerHeight = 80; // 타임스탬프를 위해 높이 증가
  const baseItemHeight = 80;
  const textMaxLength = 55;

  // Calculate dynamic height based on recommendation text lines
  let totalHeight = headerHeight + 20;
  for (const recommender of recommenders) {
    let itemHeight = baseItemHeight;
    if (recommender.recommendation_text) {
      const textLines = splitTextIntoLines(recommender.recommendation_text, textMaxLength);
      // Count all lines including empty ones for height calculation
      const totalLines = textLines.length;
      const additionalHeight = Math.max(0, (totalLines - 1) * 12); // 12px per additional line
      itemHeight += additionalHeight;
    }
    totalHeight += itemHeight;
  }
  
  const height = totalHeight;
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);

  // Pre-calculate avatar positions for clipPath definitions
  let currentY = headerHeight + 20;
  const avatarPositions = [];
  for (let i = 0; i < recommenders.length; i++) {
    const recommender = recommenders[i];
    const avatarSize = 30;
    
    // Calculate item height for this specific recommendation
    let itemHeight = baseItemHeight;
    if (recommender.recommendation_text) {
      const textLines = splitTextIntoLines(recommender.recommendation_text, textMaxLength);
      const totalLines = textLines.length;
      const additionalHeight = Math.max(0, (totalLines - 1) * 12);
      itemHeight += additionalHeight;
    }
    
    const y = currentY + 25;
    avatarPositions.push({
      index: i,
      centerX: 20 + avatarSize/2,
      centerY: y,
      radius: avatarSize/2
    });
    
    currentY += itemHeight;
  }

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" data-timestamp="${timestamp}" data-random="${random}">
    <defs>
      <style>
        .header { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 16px; font-weight: bold; fill: #333; }
        
        .name { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; font-weight: bold; fill: #0366d6; }
        .username { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; fill: #586069; }
        .date { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 10px; fill: #586069; }
        .text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; fill: #333; font-style: italic; }
        .bg { fill: #f6f8fa; stroke: #e1e4e8; stroke-width: 1; }
      </style>`;

  // Add clipPath definitions for all avatars
  avatarPositions.forEach(pos => {
    svg += `<clipPath id="avatarClip${pos.index}"><circle cx="${pos.centerX}" cy="${pos.centerY}" r="${pos.radius}"/></clipPath>`;
  });

  svg += `</defs>

    <!-- Background -->
    <rect width="${width}" height="${height}" rx="6" class="bg"/>

    <!-- Header with timestamp -->
    <text x="20" y="25" class="header">Endorsements for @${escapeXml(username)}</text>
    <text x="20" y="45" class="date" opacity="0.7">Generated: ${escapeXml(new Date().toLocaleString())}</text>`;

  // Add recommendation items
  currentY = headerHeight + 20;
  for (let index = 0; index < recommenders.length; index++) {
    const recommender = recommenders[index];
    const avatarSize = 30;
    
    // Calculate item height for this specific recommendation
    let itemHeight = baseItemHeight;
    if (recommender.recommendation_text) {
      const textLines = splitTextIntoLines(recommender.recommendation_text, textMaxLength);
      // Count all lines including empty ones for height calculation
      const totalLines = textLines.length;
      const additionalHeight = Math.max(0, (totalLines - 1) * 12);
      itemHeight += additionalHeight;
    }
    
    const y = currentY + 25;

    // Avatar using GitHub's avatar URL pattern - fetch as base64
    const username = recommender.username || 'unknown';
    const avatarUrl = `https://github.com/${username}.png`;
    let avatarDataUrl = '';
    
    try {
      avatarDataUrl = await fetchAvatarAsBase64(avatarUrl);
    } catch (error) {
      console.error(`Failed to fetch avatar for ${recommender.username}:`, error.message);
      // Use a simple default avatar - just a circle
      avatarDataUrl = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzAiIGhlaWdodD0iMzAiIHZpZXdCb3g9IjAgMCAzMCAzMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTUiIGN5PSIxNSIgcj0iMTUiIGZpbGw9IiNmMGYwZjAiLz4KPGNpcmNsZSBjeD0iMTUiIGN5PSIxNSIgcj0iMTIiIGZpbGw9IiNjY2MiLz4KPC9zdmc+';
    }
    
    // Avatar with circular clipping
    const clipId = `avatarClip${index}`;
    svg += `<image x="20" y="${y - avatarSize/2}" width="${avatarSize}" height="${avatarSize}" href="${avatarDataUrl}" clip-path="url(#${clipId})"/>`;
    // Add circular border
    svg += `<circle cx="${20 + avatarSize/2}" cy="${y}" r="${avatarSize/2}" fill="none" stroke="#ddd" stroke-width="1"/>`;

    // Name and username
    const displayName = recommender.name || recommender.username || 'Unknown User';
    const truncatedName = displayName.length > 20 ? displayName.substring(0, 17) + '...' : displayName;

    svg += `<text x="${20 + avatarSize + 15}" y="${y - 8}" class="name">${escapeXml(truncatedName)}</text>`;
    svg += `<text x="${20 + avatarSize + 15}" y="${y + 8}" class="username">@${escapeXml(username)}</text>`;

    // Date
    const date = new Date(recommender.created_at).toLocaleDateString('ko-KR');
    svg += `<text x="${width - 20}" y="${y - 8}" text-anchor="end" class="date">${escapeXml(date)}</text>`;

    // Recommendation text (multiline support)
    if (recommender.recommendation_text) {
      const textLines = splitTextIntoLines(recommender.recommendation_text, textMaxLength);
      textLines.forEach((line, lineIndex) => {
        const lineY = y + 25 + (lineIndex * 12); // 12px line height
        
        // Handle empty lines (paragraph separators) - they still take up space
        if (line.trim() === '') {
          // Empty line still takes up vertical space, but no text is rendered
          return;
        }
        
        let displayText = line;
        
        // Add quotes only to first and last non-empty lines
        const nonEmptyLines = textLines.filter(l => l.trim() !== '');
        const isFirstNonEmptyLine = line === nonEmptyLines[0];
        const isLastNonEmptyLine = line === nonEmptyLines[nonEmptyLines.length - 1];
        
        if (nonEmptyLines.length === 1) {
          // Single line: wrap with quotes
          displayText = `"${line}"`;
        } else {
          // Multiple lines: add opening quote to first line, closing quote to last line
          if (isFirstNonEmptyLine) {
            displayText = `"${line}`;
          } else if (isLastNonEmptyLine) {
            displayText = `${line}"`;
          }
        }
        
        svg += `<text x="${20 + avatarSize + 15}" y="${lineY}" class="text">${escapeXml(displayText)}</text>`;
      });
    }
    
    // Move to next item position
    currentY += itemHeight;
  }

  svg += '</svg>';
  return svg;
}


// Check if client has cached version (304 Not Modified)
function checkCacheHeaders(req, username, lastModified) {
  const etag = `"${username}-${lastModified}"`;
  const lastModifiedDate = new Date(lastModified).toUTCString();
  
  // Check If-None-Match header
  if (req.headers['if-none-match'] === etag) {
    return true;
  }
  
  // Check If-Modified-Since header
  if (req.headers['if-modified-since']) {
    const clientModifiedSince = new Date(req.headers['if-modified-since']);
    const serverLastModified = new Date(lastModified);
    if (clientModifiedSince >= serverLastModified) {
      return true;
    }
  }
  
  return false;
}

// Set Cloudflare-friendly cache headers for SVG responses
function setCloudflareCacheHeaders(res, username, lastModified) {
  const ttlSeconds = 300; // 5분 TTL
  const etag = `"${username}-${lastModified}"`;
  
  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    // 클라우드플레어가 캐시할 수 있도록 허용
    'Cache-Control': `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
    'CDN-Cache-Control': `max-age=${ttlSeconds}`,
    'Surrogate-Control': `max-age=${ttlSeconds}`,
    // ETag으로 변경 감지
    'ETag': etag,
    'Last-Modified': new Date(lastModified).toUTCString()
  });
}

// SVG route for /u/:username with Cloudflare-friendly caching
app.get('/u/:username', async (req, res) => {
  const { username } = req.params;
  const cacheKey = username.toLowerCase();
  
  console.log(`[${username}] Request received at ${new Date().toISOString()}`);
  
  // 1. 메모리 캐시 확인 (보조 캐시로 사용)
  const cached = svgCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[${username}] Memory cache HIT - checking client cache`);
    
    // 304 Not Modified 체크
    if (checkCacheHeaders(req, username, cached.lastModified)) {
      console.log(`[${username}] Client has cached version - returning 304`);
      return res.status(304).end();
    }
    
    console.log(`[${username}] Serving from memory cache`);
    // 클라우드플레어 친화적 헤더 설정
    setCloudflareCacheHeaders(res, username, cached.lastModified);
    return res.send(cached.svg);
  }
  
  // 2. 이미 생성 중인 요청이 있는지 확인
  if (pendingRequests.has(cacheKey)) {
    console.log(`[${username}] Request already in progress - waiting for result`);
    try {
      const result = await pendingRequests.get(cacheKey);
      
      // 304 Not Modified 체크
      if (checkCacheHeaders(req, username, result.lastModified)) {
        console.log(`[${username}] Client has cached version - returning 304`);
        return res.status(304).end();
      }
      
      setCloudflareCacheHeaders(res, username, result.lastModified);
      return res.send(result.svg);
    } catch (error) {
      console.error(`[${username}] Error waiting for pending request:`, error);
      return res.status(500).send(generateErrorSVG('Failed to generate SVG'));
    }
  }
  
  // 3. 새로운 SVG 생성 시작
  console.log(`[${username}] Starting new SVG generation`);
  const svgPromise = generateSVGForUserWithMetadata(username);
  pendingRequests.set(cacheKey, svgPromise);
  
  try {
    const result = await svgPromise;
    // 메모리 캐시에 저장 (5분 TTL - 클라우드플레어와 동일)
    svgCache.set(cacheKey, { 
      svg: result.svg,
      lastModified: result.lastModified,
      expiresAt: Date.now() + 5 * 60 * 1000 
    });
    
    // 304 Not Modified 체크
    if (checkCacheHeaders(req, username, result.lastModified)) {
      console.log(`[${username}] Client has cached version - returning 304`);
      return res.status(304).end();
    }
    
    // 클라우드플레어 친화적 헤더 설정
    setCloudflareCacheHeaders(res, username, result.lastModified);
    res.send(result.svg);
  } catch (error) {
    console.error(`[${username}] Error generating SVG:`, error);
    res.status(500).send(generateErrorSVG('Failed to generate SVG'));
  } finally {
    // 완료 후 pending에서 제거
    pendingRequests.delete(cacheKey);
  }
});

// SVG 생성 함수 분리 (메타데이터 포함)
async function generateSVGForUserWithMetadata(username) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT u.username, u.name, r.created_at, r.recommendation_text
            FROM recommendations r
            LEFT JOIN users u ON r.recommender_id = u.id
            WHERE LOWER(r.recommended_username) = LOWER(?) AND r.is_visible = 1
            ORDER BY r.created_at DESC`,
      [username], async (err, rows) => {
      if (err) {
        console.error(`[${username}] Database error:`, err);
        return reject(err);
      }

      try {
        console.log(`[${username}] Found ${rows.length} recommendations`);
        
        // 가장 최근 추천 시간을 lastModified로 사용
        const lastModified = rows.length > 0 ? new Date(rows[0].created_at).getTime() : Date.now();
        
        const svg = await generateRecommendationsSVG(username, rows);
        console.log(`[${username}] SVG generation completed`);
        
        resolve({
          svg,
          lastModified
        });
      } catch (error) {
        console.error(`[${username}] Error in generateRecommendationsSVG:`, error);
        reject(error);
      }
    });
  });
}

// 기존 함수 유지 (하위 호환성)
async function generateSVGForUser(username) {
  const result = await generateSVGForUserWithMetadata(username);
  return result.svg;
}

// Error SVG generator
function generateErrorSVG(message) {
  return `<svg width="400" height="100" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        .error { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; fill: #d73a49; }
        .bg { fill: #ffeef0; stroke: #d73a49; stroke-width: 1; }
      </style>
    </defs>
    <rect width="400" height="100" rx="6" class="bg"/>
    <text x="20" y="30" class="error">Error: ${message}</text>
  </svg>`;
}

if (process.env.NODE_ENV === "development") {
  app.get("/renderer-test", async (req, res) => {
    const testRows = [
      {
        recommendation_text: `
We are lucky to live in a glorious age that gives us everything we could ask for as a human race. What more could you need when you have meat covered in cheese nestled between bread as a complete meal.

From smashed patties at Shake Shack to Glamburgers at Honky Tonk, there’s a little something for everyone. Some burgers are humble, and some are ostentatious, and you just have to try them all to figure out what you want.
        `,
        name: "Jaeyeol Lee",
        username: "malkoG",
        created_at: new Date().toISOString(),
      },
    ];

    const svg = await generateRecommendationsSVG("IAOON", testRows);
    res.send(svg);
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// Recommendation page for specific user
app.get('/t/:username', (req, res) => {
  res.sendFile(__dirname + '/public/recommend.html');
});

// Admin page for user's own recommendations management
app.get('/u/:username/admin', (req, res) => {
  // Check if user is authenticated
  if (!req.isAuthenticated()) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>인증 필요</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; }
          .error { color: #d73a49; }
          .btn { background: #0366d6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1 class="error">로그인이 필요합니다</h1>
        <p>이 페이지에 접근하려면 먼저 로그인해주세요.</p>
        <a href="/" class="btn">메인 페이지로 이동</a>
      </body>
      </html>
    `);
  }

  // Check if the authenticated user matches the username in URL
  if (req.user.username.toLowerCase() !== req.params.username.toLowerCase()) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>접근 거부</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; }
          .error { color: #d73a49; }
          .btn { background: #0366d6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; display: inline-block; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1 class="error">접근 권한이 없습니다</h1>
        <p>다른 사용자의 관리 페이지에 접근할 수 없습니다.</p>
        <a href="/" class="btn">메인 페이지로 이동</a>
      </body>
      </html>
    `);
  }

  res.sendFile(__dirname + '/public/manage.html');
});

// Get recommendations received by the user for management
app.get('/api/received-recommendations/:username', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { username } = req.params;
  
  // Verify the user is accessing their own admin page
  if (req.user.username.toLowerCase() !== username.toLowerCase()) {
    return res.status(403).json({ error: 'Access denied' });
  }

  db.all(`SELECT r.id, r.recommendation_text, r.is_visible, r.created_at,
                 u.username as recommender_username, u.name as recommender_name
          FROM recommendations r
          LEFT JOIN users u ON r.recommender_id = u.id
          WHERE LOWER(r.recommended_username) = LOWER(?)
          ORDER BY r.created_at DESC`,
    [username], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
});

// Toggle recommendation visibility
app.post('/api/toggle-recommendation-visibility', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { recommendationId, isVisible } = req.body;

  if (!recommendationId || typeof isVisible !== 'boolean') {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  // Verify the recommendation is for the authenticated user (received recommendations)
  db.get(`SELECT id FROM recommendations 
          WHERE id = ? AND LOWER(recommended_username) = LOWER(?)`,
    [recommendationId, req.user.username], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Recommendation not found or not authorized' });
    }

    // Update visibility
    db.run(`UPDATE recommendations SET is_visible = ? WHERE id = ?`,
      [isVisible ? 1 : 0, recommendationId], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to update recommendation' });
      }

      // 캐시 무효화 - 해당 사용자의 SVG 캐시 제거
      const cacheKey = req.body.recommendedUsername?.toLowerCase();
      if (cacheKey) {
        svgCache.delete(cacheKey);
        console.log(`[${cacheKey}] Cache invalidated after visibility change`);
      }

      res.json({ success: true, message: 'Recommendation visibility updated' });
    });
  });
});

// Add request timeout and keep-alive settings
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Set server timeout
server.timeout = 60000; // 60 seconds
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000; // 66 seconds

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

