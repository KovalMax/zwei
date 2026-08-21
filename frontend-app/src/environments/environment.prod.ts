export const environment = {
    production: true
};

export const backends = {
    auth: 'https://auth.chat.false.tel',
    admin: 'https://kyc.chat.false.tel',
    chat: 'https://api.chat.false.tel',
    websocket: 'wss://ws.chat.false.tel/ws',
    login: 'https://auth.chat.false.tel/api/auth/login',
    registration: 'https://auth.chat.false.tel/api/auth/register',
    websocketTicket: 'https://auth.chat.false.tel/api/auth/ws-ticket',
    refresh: 'https://auth.chat.false.tel/api/auth/refresh',
    logout: 'https://auth.chat.false.tel/api/auth/logout',
    activation: 'https://auth.chat.false.tel/api/auth/activate',
    adminEndpoints: {
        login: 'https://kyc.chat.false.tel/api/auth/login',
        refresh: 'https://kyc.chat.false.tel/api/auth/refresh',
        logout: 'https://kyc.chat.false.tel/api/auth/logout',
    },
};
