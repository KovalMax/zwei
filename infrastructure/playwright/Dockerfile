FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /e2e
COPY package*.json ./
RUN npm ci
COPY . .

CMD ["npm", "test"]
