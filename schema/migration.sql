-- Database migration script
-- This script handles migrations for existing databases

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

BEGIN IMMEDIATE;

-- Ensure tables exist (for existing databases)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommender_id INTEGER NOT NULL,
    recommended_username TEXT NOT NULL COLLATE NOCASE,
    recommendation_text TEXT,
    is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_recommendations_recommended_username ON recommendations(recommended_username);
CREATE INDEX IF NOT EXISTS idx_recommendations_recommender_id ON recommendations(recommender_id);
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Migration: Remove UNIQUE constraint to allow duplicate recommendations
-- Check if the unique constraint exists and drop it
-- Note: SQLite doesn't support DROP CONSTRAINT directly, so we need to recreate the table
-- First, check if the constraint exists by looking at the table schema
-- If the constraint exists, we'll recreate the table without it

-- Create a temporary table with the new schema (without UNIQUE constraint)
CREATE TABLE IF NOT EXISTS recommendations_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommender_id INTEGER NOT NULL,
    recommended_username TEXT NOT NULL COLLATE NOCASE,
    recommendation_text TEXT,
    is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

-- Copy data from old table to new table (only if old table exists and has data)
-- This will be handled by the application logic to avoid data loss

COMMIT;
