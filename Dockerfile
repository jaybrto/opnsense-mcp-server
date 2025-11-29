FROM node:20-alpine

WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache git

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source and build artifacts
COPY index.js tools-generated.json ./

# Set environment variables for SSE mode
ENV MCP_TRANSPORT=sse
ENV PORT=3000
ENV NODE_ENV=production

# Expose the SSE port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run the server
CMD ["node", "index.js"]
