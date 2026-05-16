/**
 * Production environment configuration.
 * Replace with your actual deployed URLs.
 */
export const environment = {
  production: true,
  googleClientId: '82552654884-304a493jmmlsa7v9bth1ukc90h903b8u.apps.googleusercontent.com',
  apiGatewayUrl: 'https://api.yourdomain.com',
  auth: {
    baseUrl: 'https://api.yourdomain.com/api/auth'
  },
  rooms: {
    baseUrl: 'https://api.yourdomain.com/api/rooms'
  },
  messages: {
    baseUrl: 'https://api.yourdomain.com/api/messages'
  },
  presence: {
    baseUrl: 'https://api.yourdomain.com/api/presence'
  },
  websocket: {
    url: 'https://api.yourdomain.com/ws'
  }
};
