/**
 * Development environment configuration.
 * These URLs point to locally running services.
 * The API Gateway at :8080 routes all requests to the correct microservice.
 */
export const environment = {
  production: false,
  // ── Google OAuth ──────────────────────────────────────────────────────────
  // Replace with your real Client ID from Google Cloud Console.
  // See: https://console.cloud.google.com/ → APIs & Services → Credentials
  googleClientId: '82552654884-304a493jmmlsa7v9bth1ukc90h903b8u.apps.googleusercontent.com',
  // ─────────────────────────────────────────────────────────────────────────
  apiGatewayUrl: 'http://localhost:8080',
  auth: {
    baseUrl: 'http://localhost:8080/api/auth'
  },
  rooms: {
    baseUrl: 'http://localhost:8080/api/rooms'
  },
  messages: {
    baseUrl: 'http://localhost:8080/api/messages'
  },
  notifications: {
    baseUrl: 'http://localhost:8080/api/notifications'
  },
  presence: {
    baseUrl: 'http://localhost:8080/api/presence'
  },
  websocket: {
    url: 'http://localhost:8080/ws'
  }
};

