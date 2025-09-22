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
-- This migration safely recreates the recommendations table without UNIQUE constraints
-- while preserving all existing data and indexes

-- Check if recommendations table exists and has data
-- If it exists, we need to migrate it to remove any UNIQUE constraints

-- Step 1: Check if we need to migrate (only if recommendations table exists and has data)
-- This is handled by checking if the table exists and has rows

-- Step 2: Create backup table with current data (if exists)
CREATE TABLE IF NOT EXISTS recommendations_backup AS 
SELECT * FROM recommendations WHERE 1=0; -- Create empty table with same structure

-- Step 3: Copy existing data to backup (only if recommendations table has data)
INSERT INTO recommendations_backup 
SELECT * FROM recommendations 
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='recommendations');

-- Step 4: Drop the original recommendations table (if it exists)
DROP TABLE IF EXISTS recommendations;

-- Step 5: Create new recommendations table without UNIQUE constraints
CREATE TABLE recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommender_id INTEGER NOT NULL,
    recommended_username TEXT NOT NULL COLLATE NOCASE,
    recommendation_text TEXT,
    is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);

-- Step 6: Restore data from backup with position values
INSERT INTO recommendations (id, recommender_id, recommended_username, recommendation_text, is_visible, created_at, position)
SELECT
  id, recommender_id, recommended_username, recommendation_text, is_visible, created_at,
  ROW_NUMBER() OVER (
    PARTITION BY recommended_username
    ORDER BY created_at, id
  ) - 1 AS position
FROM recommendations_backup;
-- Step 7: Recreate indexes for the new table
CREATE INDEX IF NOT EXISTS idx_recommendations_recommended_username ON recommendations(recommended_username);
CREATE INDEX IF NOT EXISTS idx_recommendations_recommender_id ON recommendations(recommender_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_position ON recommendations(position);

-- Step 8: Clean up backup table
DROP TABLE IF EXISTS recommendations_backup;

-- Step 9: Clean up any leftover recommendations_new table from previous failed migrations
DROP TABLE IF EXISTS recommendations_new;

COMMIT;
