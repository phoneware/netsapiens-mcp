# Multi-stage build for optimal image size
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies including devDependencies for TypeScript compilation
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build

# Runtime stage
FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/build ./build

# Set default runtime environment variables
ENV NODE_ENV=production \
    DEBUG=false \
    MCP_TRANSPORT=http \
    MCP_PORT=3000

# Expose HTTP port
EXPOSE 3000

# Configure non-root user and secure token directory
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs -h /home/nodejs && \
    chown -R nodejs:nodejs /app && \
    mkdir -p /home/nodejs/.netsapiens-mcp && \
    chown nodejs:nodejs /home/nodejs/.netsapiens-mcp && \
    chmod 700 /home/nodejs/.netsapiens-mcp

USER nodejs

ENTRYPOINT ["node", "build/index.js"]
