import {Injectable} from '@angular/core';
import {backends} from '../../environments/environment';

@Injectable({providedIn: 'root'})
export class HostService {
    public isAdminHost(): boolean {
        return window.location.hostname === 'kyc.chat.false.tel' || window.location.hostname === 'kyc.localhost';
    }

    public authEndpoint(kind: 'login' | 'refresh' | 'logout' | 'profile' | 'activate'): string {
        if (!this.isAdminHost()) {
            if (kind === 'profile') return `${backends.auth}/api/auth/me`;
            if (kind === 'activate') return backends.activation;
            return backends[kind];
        }
        if (kind === 'profile') return `${backends.admin}/api/auth/me`;
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
