FROM node:26.4.0-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY . .
RUN npm run build

# Run unit tests on start
CMD ["npm", "test"]
