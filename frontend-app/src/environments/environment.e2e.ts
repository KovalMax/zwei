export const environment = {
    production: false,
    serviceWorkerEnabled: true,
    serviceWorkerWorker: 'ngsw-worker-e2e.js',
    serviceWorkerRegistrationStrategy: 'registerImmediately',
};

export const backends = {
    auth: 'https://chat.localhost',
    admin: 'https://kyc.localhost',
    chat: 'https://api.chat.localhost',
    websocket: 'wss://ws.chat.localhost/ws/v3',
    login: 'https://chat.localhost/api/auth/login',
    registration: 'https://chat.localhost/api/auth/register',
    websocketTicket: 'https://chat.localhost/api/auth/ws-ticket',
    refresh: 'https://chat.localhost/api/auth/refresh',
    logout: 'https://chat.localhost/api/auth/logout',
    activation: 'https://chat.localhost/api/auth/activate',
    adminEndpoints: {
        login: 'https://kyc.localhost/api/auth/login',
        refresh: 'https://kyc.localhost/api/auth/refresh',
        logout: 'https://kyc.localhost/api/auth/logout',
    },
};
