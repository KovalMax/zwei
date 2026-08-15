import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {HostService} from './host.service';

export type KYCStatus = 1 | 2 | 3;

export interface AdminUser {
    id: string;
    email: string;
    display_name: string;
    kyc_status: KYCStatus;
    created_at: string;
    email_verified: boolean;
}

export interface Invitation {
    id: string;
    email: string;
    expires_at: string;
    redeemed_at?: string;
    revoked_at?: string;
    created_at: string;
}

export interface CreatedInvitation {
    invitation: Invitation;
    code: string;
}

@Injectable({providedIn: 'root'})
export class AdminService {
    constructor(private http: HttpClient, private host: HostService) {}

    public checkAccess(): Observable<{id: string; admin: boolean}> {
        return this.http.get<{id: string; admin: boolean}>(this.host.adminEndpoint('/api/admin/me'));
    }

    public users(): Observable<AdminUser[]> {
        return this.http.get<AdminUser[]>(this.host.adminEndpoint('/api/admin/users'));
    }

    public activateUser(id: string): Observable<void> {
        return this.http.post<void>(this.host.adminEndpoint(`/api/admin/users/${id}/activate`), {});
    }

    public blockUser(id: string): Observable<void> {
        return this.http.post<void>(this.host.adminEndpoint(`/api/admin/users/${id}/block`), {});
    }

    public invitations(): Observable<Invitation[]> {
        return this.http.get<Invitation[]>(this.host.adminEndpoint('/api/admin/invitations'));
    }

    public createInvitation(email: string): Observable<CreatedInvitation> {
        return this.http.post<CreatedInvitation>(this.host.adminEndpoint('/api/admin/invitations'), {email});
    }

    public revokeInvitation(id: string): Observable<void> {
        return this.http.post<void>(this.host.adminEndpoint(`/api/admin/invitations/${id}/revoke`), {});
    }
}
