#!/bin/sh

# Enable strict error handling
set -eu

# Database initialization and migration script
# This script creates the SQLite database and tables if they don't exist
# Also handles database migrations for existing databases

DATA_DIR="${REFERRALS_DATA_DIR:-/app/data}"
DB_PATH="${REFERRALS_DB_PATH:-$DATA_DIR/referrals.db}"

echo "Starting database initialization and migration..."
echo "DATA_DIR: $DATA_DIR"
echo "DB_PATH: $DB_PATH"

# Create data directory if it doesn't exist
mkdir -p "$DATA_DIR"

# Check if database file exists
if [ ! -f "$DB_PATH" ]; then
    echo "Database file not found. Creating new database..."
    
    # Create the database file
    touch "$DB_PATH"
    
    # Initialize database with schema file
    sqlite3 "$DB_PATH" < /app/schema/init.sql
    echo "Database initialized successfully!"
    echo "Database file created at: $DB_PATH"
else
    echo "Database file already exists at: $DB_PATH"
    echo "Running database migrations..."
    
    # Run migrations for existing databases
    sqlite3 "$DB_PATH" < /app/schema/migration.sql
    
    # Check if recommendation_text column exists
    HAS_RECOMMENDATION_TEXT=$(sqlite3 "$DB_PATH" "PRAGMA table_info(recommendations);" | awk -F'|' '$2 == "recommendation_text" {print $2}' | wc -l)
    
    if [ "$HAS_RECOMMENDATION_TEXT" -eq 0 ]; then
        echo "Adding recommendation_text column..."
        sqlite3 "$DB_PATH" "ALTER TABLE recommendations ADD COLUMN recommendation_text TEXT;"
    else
        echo "recommendation_text column already exists."
    fi

    # Check if is_visible column exists
    HAS_IS_VISIBLE=$(sqlite3 "$DB_PATH" "PRAGMA table_info(recommendations);" | awk -F'|' '$2 == "is_visible" {print $2}' | wc -l)
    
    if [ "$HAS_IS_VISIBLE" -eq 0 ]; then
        echo "Adding is_visible column..."
        sqlite3 "$DB_PATH" "ALTER TABLE recommendations ADD COLUMN is_visible INTEGER DEFAULT 1 CHECK (is_visible IN (0, 1));"
    else
        echo "is_visible column already exists."
    fi

    # Migrate BOOLEAN to INTEGER with CHECK constraint for is_visible
    echo "Migrating BOOLEAN to INTEGER with CHECK constraint..."
    sqlite3 "$DB_PATH" "
    -- Update any NULL values to 1 (true) for is_visible
    UPDATE recommendations SET is_visible = 1 WHERE is_visible IS NULL;
    
    -- Add NOT NULL constraint to critical columns if they don't exist
    -- Note: SQLite doesn't support adding NOT NULL to existing columns directly
    -- This is handled by the application logic to ensure data integrity
    "

    # Add case-insensitive collation for recommended_username
    echo "Adding case-insensitive collation for recommended_username..."
    sqlite3 "$DB_PATH" "
    -- Create a new table with NOCASE collation
    CREATE TABLE recommendations_temp AS SELECT * FROM recommendations;
    DROP TABLE recommendations;
    CREATE TABLE recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recommender_id INTEGER NOT NULL,
        recommended_username TEXT NOT NULL COLLATE NOCASE,
        recommendation_text TEXT,
        is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (recommender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
    );
    INSERT INTO recommendations SELECT * FROM recommendations_temp;
    DROP TABLE recommendations_temp;
    "

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

# Set proper permissions and ownership
# Get the current user (should be the same as the app user in container)
CURRENT_USER=$(whoami)
CURRENT_GROUP=$(id -gn)

# Set ownership to current user
chown "$CURRENT_USER:$CURRENT_GROUP" "$DB_PATH" 2>/dev/null || true
chown -R "$CURRENT_USER:$CURRENT_GROUP" "$DATA_DIR" 2>/dev/null || true

# Set restrictive permissions for security
chmod 660 "$DB_PATH"  # Database file: read/write for owner and group only
chmod 770 "$DATA_DIR" # Data directory: read/write/execute for owner and group only

echo "Database initialization and migration completed!"

# Start the application
echo "Starting application..."
exec npm start
