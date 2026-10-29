import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {backends} from '../../environments/environment';
import {PushSubscriptionClient} from './push-subscription.client';

describe('PushSubscriptionClient', () => {
    let client: PushSubscriptionClient;
    let http: HttpTestingController;
    beforeEach(() => {
        TestBed.configureTestingModule({imports: [HttpClientTestingModule]});
        client = TestBed.inject(PushSubscriptionClient);
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    it('loads the public VAPID key from the auth adapter endpoint', () => {
        client.vapidPublicKey().subscribe(result => expect(result.public_key).toBe('public'));
        const request = http.expectOne(`${backends.auth}/api/auth/push/vapid-public-key`);
        expect(request.request.method).toBe('GET');
        request.flush({public_key: 'public'});
    });

    it('posts only the browser subscription wire fields', () => {
        const body = {endpoint: 'https://push.example.test/sub', expirationTime: null, keys: {p256dh: 'dh', auth: 'auth'}};
        client.save(body).subscribe();
        const request = http.expectOne(`${backends.auth}/api/auth/push-subscription`);
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual(body);
        request.flush(null);
    });

    it('deletes the current account and device registration without a body', () => {
        client.remove().subscribe();
        const request = http.expectOne(`${backends.auth}/api/auth/push-subscription/current`);
        expect(request.request.method).toBe('DELETE');
        expect(request.request.body).toBeNull();
        request.flush(null);
    });

    it('verifies the subscription with a read-only POST', () => {
        const body = {endpoint: 'https://push.example.test/sub', expirationTime: null, keys: {p256dh: 'dh', auth: 'auth'}};
        client.verify(body).subscribe(result => expect(result.matches).toBe(true));
        const request = http.expectOne(`${backends.auth}/api/auth/push-subscription/verify`);
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual(body);
        request.flush({matches: true});
    });
});
