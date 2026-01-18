# Use a lightweight Node.js image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Expose the port the addon listens on
EXPOSE 7005

# Run the server
CMD ["npm", "start"]
