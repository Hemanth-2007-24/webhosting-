# Use the official lightweight Node.js 18 slim image
FROM node:18-slim

# Install git (required for simple-git repository cloning)
RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create and set the working directory
WORKDIR /app

# Copy package configurations first to leverage Docker layer caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all application source files, styles, and html assets
COPY . .

# Ensure required run-time directories exist
RUN mkdir -p uploads deployments compiled_apps

# Set default fallback port (Back4app overrides this with its own PORT env var)
ENV PORT=8080
EXPOSE 8080

# Command to start the application
CMD ["npm", "start"]