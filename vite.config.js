export default {
  server: {
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3001",
      "/img": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
};