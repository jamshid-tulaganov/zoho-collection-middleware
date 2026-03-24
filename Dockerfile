FROM node:22-slim

# Install system dependencies required by Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-liberation libappindicator3-1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install
RUN npx playwright install chromium

COPY . .

EXPOSE 3001

CMD ["node", "src/server.js"]
