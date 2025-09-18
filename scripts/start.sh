#!/bin/sh

# Database initialization and migration script
# This script creates the SQLite database and tables if they don't exist
# Also handles database migrations for existing databases

DB_PATH="/app/referrals.db"
DATA_DIR="/app/data"

echo "Starting database initialization and migration..."

# Create data directory if it doesn't exist
mkdir -p "$DATA_DIR"

# Check if database file exists
if [ ! -f "$DB_PATH" ]; then
    echo "Database file not found. Creating new database..."
    
    # Create the database file
    touch "$DB_PATH"
    
    # Initialize database with tables
    sqlite3 "$DB_PATH" <<EOF
-- Enable foreign key constraints
PRAGMA foreign_keys = ON;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER UNIQUE,
    username TEXT UNIQUE,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create recommendations table
CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommender_id INTEGER,
    recommended_username TEXT,
    recommendation_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    UNIQUE(recommender_id, recommended_username)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_recommendations_recommended_username ON recommendations(recommended_username);
CREATE INDEX IF NOT EXISTS idx_recommendations_recommender_id ON recommendations(recommender_id);
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Verify tables were created
.tables
.schema users
.schema recommendations
EOF

    if [ $? -eq 0 ]; then
        echo "Database initialized successfully!"
        echo "Database file created at: $DB_PATH"
    else
        echo "Error: Failed to initialize database"
        exit 1
    fi
else
    echo "Database file already exists at: $DB_PATH"
    echo "Running database migrations..."
    
    # Run migrations for existing databases
    sqlite3 "$DB_PATH" <<EOF
-- Enable foreign key constraints
PRAGMA foreign_keys = ON;
EOF

    # Check if recommendation_text column exists
    HAS_RECOMMENDATION_TEXT=$(sqlite3 "$DB_PATH" "PRAGMA table_info(recommendations);" | grep -c "recommendation_text" || echo "0")
    
    if [ "$HAS_RECOMMENDATION_TEXT" -eq 0 ]; then
        echo "Adding recommendation_text column..."
        sqlite3 "$DB_PATH" "ALTER TABLE recommendations ADD COLUMN recommendation_text TEXT;"
    else
        echo "recommendation_text column already exists."
    fi

    
    # Quick integrity check
    TABLE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users', 'recommendations');" 2>/dev/null || echo "0")
    
    if [ "$TABLE_COUNT" -eq 2 ]; then
        echo "Database tables are present and valid."
        echo "Database migration completed!"
    else
        echo "Warning: Database tables may be missing or corrupted."
        echo "Consider recreating the database file."
        exit 1
    fi
fi

# Set proper permissions
chmod 664 "$DB_PATH"
chmod 755 "$DATA_DIR"

echo "Database initialization and migration completed!"

# Start the application
echo "Starting application..."
exec npm start
