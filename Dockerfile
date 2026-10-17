# The server as a container image. It runs with Docker Compose on the Compute Engine VM
# (decision 0015); deploy.sh on the VM builds this file. Steps: docs/runbooks/vm-deploy.md.

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

# The VM's env file sets PORT=8080; Docker sends SIGTERM before stopping; index.js handles both.
EXPOSE 8080
CMD ["node", "index.js"]
