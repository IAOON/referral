-- Database initialization script
-- This script creates the SQLite database schema and initial setup

-- Enable foreign key constraints
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create recommendations table
CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommender_id INTEGER NOT NULL,
    recommended_username TEXT NOT NULL COLLATE NOCASE,
    recommendation_text TEXT,
    is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_recommendations_recommended_username ON recommendations(recommended_username);
CREATE INDEX IF NOT EXISTS idx_recommendations_recommender_id ON recommendations(recommender_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_position ON recommendations(position);
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Verify tables were created
.tables
.schema users
.schema recommendations
