const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
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
const db = new sqlite3.Database('./referrals.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    // Enforce foreign key constraints to protect referential integrity
    db.run('PRAGMA foreign_keys = ON');
    initDatabase();
  }
});

function initDatabase() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER UNIQUE,
    username TEXT UNIQUE,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommender_id INTEGER,
    recommended_username TEXT,
    recommendation_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    UNIQUE(recommender_id, recommended_username)
  )`);

  // Add recommendation_text column if it doesn't exist (for existing databases)
  db.run(`ALTER TABLE recommendations ADD COLUMN recommendation_text TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.log('recommendation_text column already exists or error:', err.message);
    } else if (!err) {
      console.log('Added recommendation_text column to recommendations table');
    }
  });
}

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'SESSION_SECRET_EXAMPLE',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

// Passport setup
if (process.env.GITHUB_CLIENT_ID) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL:
          process.env.CALLBACK_URL ||
          "http://localhost:3000/auth/github/callback",
      },
      function (accessToken, refreshToken, profile, done) {
        // Upsert user without replacing the row to preserve the stable primary key
        db.run(
          `INSERT INTO users (github_id, username, name)
       VALUES (?, ?, ?)
       ON CONFLICT(github_id) DO UPDATE SET
         username=excluded.username,
         name=excluded.name`,
          [profile.id, profile.username, profile.displayName],
          function (err) {
            if (err) {
              return done(err);
            }
            // Fetch the (stable) user id to keep downstream logic working
            db.get(
              `SELECT id FROM users WHERE LOWER(github_id) = ?`,
              [profile.id],
              (selErr, row) => {
                if (selErr) {
                  return done(selErr);
                }
                return done(null, {
                  id: row?.id,
                  github_id: profile.id,
                  username: profile.username,
                });
              },
            );
          },
        );
      },
    ),
  );
}

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

app.use(passport.initialize());
app.use(passport.session());

// Cloudflare-friendly caching middleware for SVG routes
app.use('/api/recommendations', (req, res, next) => {
  // 클라우드플레어가 캐시할 수 있도록 허용 (5분 TTL)
  res.set({
    'Cache-Control': 'public, max-age=300, s-maxage=300',
    'CDN-Cache-Control': 'max-age=300',
    'Surrogate-Control': 'max-age=300'
  });
  next();
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Authentication routes
app.get('/auth/github',
  function(req, res, next) {
    // Pass returnTo as state parameter to GitHub OAuth
    const state = req.query.returnTo || '/';
    passport.authenticate('github', { 
      scope: ['user:email'],
      state: state
    })(req, res, next);
  });

app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/login' }),
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

  // Check if user already recommended this person
  db.get(`SELECT id FROM recommendations
          WHERE recommender_id = (SELECT id FROM users WHERE LOWER(github_id) = ?)
          AND LOWER(recommended_username) = LOWER(?)`,
    [req.user.github_id, recommendedUsername], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (row) {
      return res.status(400).json({ error: 'You have already recommended this user' });
    }

    // Add recommendation
    db.run(`INSERT INTO recommendations (recommender_id, recommended_username, recommendation_text)
            VALUES ((SELECT id FROM users WHERE LOWER(github_id) = ?), ?, ?)`,
      [req.user.github_id, recommendedUsername, recommendationText || null], function(err) {
      if (err) {
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
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReferralBot/1.0)',
        'Accept': 'image/*'
      }
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
    
    // Set timeout
    request.setTimeout(10000, () => {
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
    <text x="20" y="25" class="header">Endorsements for @${username}</text>
    <text x="20" y="45" class="date" opacity="0.7">Generated: ${new Date().toLocaleString()}</text>`;

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

    svg += `<text x="${20 + avatarSize + 15}" y="${y - 8}" class="name">${truncatedName}</text>`;
    svg += `<text x="${20 + avatarSize + 15}" y="${y + 8}" class="username">@${username}</text>`;

    // Date
    const date = new Date(recommender.created_at).toLocaleDateString('ko-KR');
    svg += `<text x="${width - 20}" y="${y - 8}" text-anchor="end" class="date">${date}</text>`;

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
        
        svg += `<text x="${20 + avatarSize + 15}" y="${lineY}" class="text">${displayText}</text>`;
      });
    }
    
    // Move to next item position
    currentY += itemHeight;
  }

  svg += '</svg>';
  return svg;
}

// 클라우드플레어 친화적 캐시 헤더
function setCloudflareCacheHeaders(res, ttlSeconds = 300) {
  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    // 클라우드플레어가 이해할 수 있는 캐시 헤더
    'Cache-Control': `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
    'CDN-Cache-Control': `max-age=${ttlSeconds}`,
    'Surrogate-Control': `max-age=${ttlSeconds}`,
    // ETag으로 변경 감지
    'ETag': `"${username}-${lastModified}"`,
    'Last-Modified': new Date(lastModified).toUTCString(),
  });
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
    'Last-Modified': new Date(lastModified).toUTCString(),
    // 클라우드플레어 특화 헤더
    'CF-Cache-Status': 'HIT' // 또는 MISS
  });
}

app.get('/api/recommendations/:username', async (req, res) => {
  const { username } = req.params;
  
  console.log(`Generating SVG for ${username} at ${new Date().toISOString()}`);

  db.all(`SELECT u.username, u.name, r.created_at, r.recommendation_text
          FROM recommendations r
          LEFT JOIN users u ON r.recommender_id = u.id
          WHERE LOWER(r.recommended_username) = LOWER(?)
          ORDER BY r.created_at DESC`,
    [username], async (err, rows) => {
    if (err) {
      console.error('Database error for', username, ':', err);
      return res.status(500).send(generateErrorSVG('Database error'));
    }

    try {
      console.log(`Found ${rows.length} recommendations for ${username}`);
      
      // 가장 최근 추천 시간을 lastModified로 사용
      const lastModified = rows.length > 0 ? new Date(rows[0].created_at).getTime() : Date.now();
      
      // 클라우드플레어 친화적 캐시 헤더 설정
      setCloudflareCacheHeaders(res, username, lastModified);
      
      const svg = await generateRecommendationsSVG(username, rows);
      res.send(svg);
    } catch (error) {
      console.error('Error generating SVG for', username, ':', error);
      res.status(500).send(generateErrorSVG('Failed to generate SVG'));
    }
  });

});

// Keep JSON API for programmatic access
app.get('/api/recommendations/:username/json', (req, res) => {
  const { username } = req.params;

  db.all(`SELECT u.username, u.name, r.created_at, r.recommendation_text
          FROM recommendations r
          LEFT JOIN users u ON r.recommender_id = u.id
          WHERE LOWER(r.recommended_username) = LOWER(?)
          ORDER BY r.created_at DESC`,
    [username], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({
      username: username,
      recommenders: rows
    });
  });
});

// SVG route for /u/:username with Cloudflare-friendly caching
app.get('/u/:username', async (req, res) => {
  const { username } = req.params;
  const cacheKey = username.toLowerCase();
  
  console.log(`[${username}] Request received at ${new Date().toISOString()}`);
  
  // 1. 메모리 캐시 확인 (보조 캐시로 사용)
  const cached = svgCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[${username}] Memory cache HIT - serving from cache`);
    // 클라우드플레어 친화적 헤더 설정
    setCloudflareCacheHeaders(res, username, cached.lastModified);
    return res.send(cached.svg);
  }
  
  // 2. 이미 생성 중인 요청이 있는지 확인
  if (pendingRequests.has(cacheKey)) {
    console.log(`[${username}] Request already in progress - waiting for result`);
    try {
      const result = await pendingRequests.get(cacheKey);
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
            WHERE LOWER(r.recommended_username) = LOWER(?)
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

