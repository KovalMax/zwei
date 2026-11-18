FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /e2e
COPY package*.json ./
RUN npm ci
COPY . .

CMD ["npm", "test"]
