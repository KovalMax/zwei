export const environment = {
    production: true
};

export const backends = {
    auth: 'https://auth.localhost',
    chat: 'https://api.chat.localhost',
    websocket: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
    login: 'https://auth.localhost/api/auth/login',
    registration: 'https://auth.localhost/api/auth/register',
    websocketTicket: 'https://auth.localhost/api/auth/ws-ticket',
};
