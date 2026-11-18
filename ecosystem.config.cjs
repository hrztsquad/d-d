module.exports = {
  apps: [
    {
      name: "doodstream-telegram-bot",
      script: "index.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 20,
      min_uptime: "10s",
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "1G",
      time: true,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
