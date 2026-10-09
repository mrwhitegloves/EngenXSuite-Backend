# The server as a container image, for Google Cloud Run.
# Build and deploy: see docs/runbooks/deploy.md (Cloud Run builds this file itself).

# The Node.js LTS line the project is written for (package.json "engines").
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is rebuilt only when the package files change.
# --omit=dev leaves out test and lint tools. --ignore-scripts runs no install scripts at all,
# so nothing from a package executes during the build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The source. What is left out is listed in .dockerignore (secrets, tests, local files).
COPY . .

# Run as the image's unprivileged user, not as root.
USER node

# Cloud Run sets PORT (8080) and sends SIGTERM before stopping; index.js handles both.
EXPOSE 8080
CMD ["node", "index.js"]
