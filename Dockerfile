# ============================================================
#  VoiceMailAssist v4 — Dockerfile
#  Builds the entire Node.js app into a Docker container
#
#  HOW TO USE:
#  Step 1 — Build:   docker build -t voicemailassist .
#  Step 2 — Run:     docker run -p 3000:3000 voicemailassist
#  Step 3 — Open:    http://localhost:3000/app.html
# ============================================================

# Use official Node.js LTS image (lightweight alpine version)
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package.json first (for faster builds — Docker caches this layer)
COPY package.json ./

# Install all dependencies
RUN npm install --production

# Copy the rest of the project files
COPY . .

# Tell Docker this app uses port 3000
EXPOSE 3000

# Health check — Docker will verify the app is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

# Start the server
CMD ["node", "server.js"]
