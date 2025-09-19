FROM node:18-alpine

WORKDIR /app

# Install sqlite3 for database initialization
RUN apk add --no-cache sqlite

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY server.js ./
COPY public ./public/
COPY scripts ./scripts/
COPY schema ./schema/

# Create directory for database
RUN mkdir -p /app/data

# Make start script executable
RUN chmod +x /app/scripts/start.sh

# Expose port
EXPOSE 3000

# Start the application with database initialization
CMD ["/app/scripts/start.sh"]

