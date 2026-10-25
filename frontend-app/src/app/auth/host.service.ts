import {Injectable} from '@angular/core';
import {backends} from '../../environments/environment';

@Injectable({providedIn: 'root'})
export class HostService {
    public isAdminHost(): boolean {
        return window.location.hostname === 'kyc.chat.false.tel' || window.location.hostname === 'kyc.localhost';
    }

    public authEndpoint(kind: 'login' | 'refresh' | 'logout' | 'profile' | 'media-policy' | 'giphy-key' | 'activate' | 'push-vapid-key' | 'push-subscription'): string {
        if (kind === 'push-vapid-key' || kind === 'push-subscription') return `${backends.auth}/api/auth/${kind === 'push-vapid-key' ? 'push/vapid-public-key' : 'push-subscription'}`;
        if (!this.isAdminHost()) {
            if (kind === 'profile') return `${backends.auth}/api/auth/me`;
            if (kind === 'media-policy') return `${backends.auth}/api/auth/media-policy`;
            if (kind === 'giphy-key') return `${backends.auth}/api/auth/giphy-key`;
            if (kind === 'activate') return backends.activation;
            return backends[kind];
        }
        if (kind === 'profile') return `${backends.admin}/api/auth/me`;
        if (kind === 'media-policy') return `${backends.admin}/api/auth/media-policy`;
        if (kind === 'giphy-key') return `${backends.admin}/api/auth/giphy-key`;
        if (kind === 'activate') return `${backends.activation}`;
        return backends.adminEndpoints[kind];
    }

    public adminEndpoint(path: string): string {
        return `${backends.admin}${path}`;
    }

    public defaultAuthenticatedRoute(): string {
        return this.isAdminHost() ? 'admin' : 'home';
    }
}
