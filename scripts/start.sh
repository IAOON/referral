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
    sqlite3 -bail "$DB_PATH" < /app/schema/init.sql
    echo "Database initialized successfully!"
    echo "Database file created at: $DB_PATH"
else
    echo "Database file already exists at: $DB_PATH"
    echo "Running database migrations..."
    
    # Safety check: Clean up any leftover temporary tables from previous failed migrations
    echo "Cleaning up any leftover temporary tables..."
    sqlite3 -bail "$DB_PATH" "
    DROP TABLE IF EXISTS recommendations_new;
    DROP TABLE IF EXISTS recommendations_temp;
    DROP TABLE IF EXISTS recommendations_backup;
    " 2>/dev/null || true
    
    # Run migrations for existing databases
    echo "Running migration script..."
    if sqlite3 -bail "$DB_PATH" < /app/schema/migration.sql; then
        echo "Migration script executed successfully."
    else
        echo "Error: Migration script failed!"
        echo "Database may be in an inconsistent state."
        exit 1
    fi

    # Verify migration success
    echo "Verifying migration results..."
    
    # Check if all required tables exist
    TABLE_COUNT=$(sqlite3 -bail "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users', 'recommendations');" 2>/dev/null || echo "0")
    
    if [ "$TABLE_COUNT" -eq 2 ]; then
        echo "✓ All required tables are present."
        
        # Check if recommendations table has the correct structure
        HAS_RECOMMENDATION_TEXT=$(sqlite3 -bail "$DB_PATH" "PRAGMA table_info(recommendations);" | awk -F'|' '$2 == "recommendation_text" {print $2}' | wc -l)
        HAS_IS_VISIBLE=$(sqlite3 -bail "$DB_PATH" "PRAGMA table_info(recommendations);" | awk -F'|' '$2 == "is_visible" {print $2}' | wc -l)
        
        if [ "$HAS_RECOMMENDATION_TEXT" -eq 1 ] && [ "$HAS_IS_VISIBLE" -eq 1 ]; then
            echo "✓ Recommendations table has correct structure."
            echo "✓ Database migration completed successfully!"
        else
            echo "✗ Warning: Recommendations table structure may be incorrect."
            echo "Missing columns: recommendation_text=$HAS_RECOMMENDATION_TEXT, is_visible=$HAS_IS_VISIBLE"
            exit 1
        fi
    else
        echo "✗ Error: Required tables are missing or corrupted."
        echo "Expected 2 tables (users, recommendations), found $TABLE_COUNT"
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
