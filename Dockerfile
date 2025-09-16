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
COPY init-db.sh ./

# Create directory for database
RUN mkdir -p /app/data

# Make init script executable
RUN chmod +x /app/init-db.sh

# Expose port
EXPOSE 3000

# Create startup script
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'echo "Starting database initialization..."' >> /app/start.sh && \
    echo '/app/init-db.sh' >> /app/start.sh && \
    echo 'echo "Starting application..."' >> /app/start.sh && \
    echo 'exec npm start' >> /app/start.sh && \
    chmod +x /app/start.sh

# Start the application with database initialization
CMD ["/app/start.sh"]

