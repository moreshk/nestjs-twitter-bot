FROM node:18-alpine

WORKDIR /app

# Create data directory and set permissions
RUN mkdir -p /app/data && chown node:node /app/data

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Switch to non-root user for security
USER node

CMD ["npm", "run", "start:prod"]