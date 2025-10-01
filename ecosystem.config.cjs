module.exports = {
  apps: [
    {
      name: 'aippt-downloader',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--enable-source-maps',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
        ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123'
      }
    }
  ]
};
