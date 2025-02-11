FROM node:18-alpine

WORKDIR /app

# Create data directory and set permissions
RUN mkdir -p /app/data && chown node:node /app/data

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies)
RUN npm install

COPY . .
RUN npm run build

# Remove devDependencies for production
RUN npm prune --production

# Switch to non-root user for security
USER node

CMD ["npm", "run", "start:prod"]