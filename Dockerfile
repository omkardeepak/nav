FROM node:22-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY src/ ./src/
COPY public/ ./public/
COPY schema.sql ./

# Run as non-root user
USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
