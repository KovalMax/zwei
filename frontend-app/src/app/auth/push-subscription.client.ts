import {HttpClient} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {HostService} from './host.service';

export interface PushSubscriptionWire {
    endpoint: string;
    expirationTime: number | null;
    keys: {p256dh: string; auth: string};
}

@Injectable({providedIn: 'root'})
export class PushSubscriptionClient {
    constructor(private readonly http: HttpClient, private readonly host: HostService) {}

    public vapidPublicKey(): Observable<{public_key: string}> {
        return this.http.get<{public_key: string}>(this.host.authEndpoint('push-vapid-key'));
    }

    public save(subscription: PushSubscriptionWire): Observable<void> {
        return this.http.post<void>(this.host.authEndpoint('push-subscription'), subscription);
    }

    public verify(subscription: PushSubscriptionWire): Observable<{matches: boolean}> {
        return this.http.post<{matches: boolean}>(`${this.host.authEndpoint('push-subscription')}/verify`, subscription);
    }

    public remove(): Observable<void> {
        return this.http.delete<void>(`${this.host.authEndpoint('push-subscription')}/current`);
    }
}
